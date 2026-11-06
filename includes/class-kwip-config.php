<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Storage, validation and serialization of the animation config.
 *
 * Shape (selector -> trigger -> settings):
 * {
 *   ".hero-title": { "load": { "animation": "fade-up", "duration": 1.5, "delay": 0 } },
 *   "#main-button": { "click": { "animation": "spin", "duration": 0.8 } }
 * }
 */
final class KWIPA_Config {

	const OPTION_KEY         = 'kwipa_animation_config';
	const MAX_SELECTORS      = 500;
	const MAX_SELECTOR_LEN   = 255;
	const MAX_DURATION       = 30.0;
	const MAX_DELAY          = 30.0;
	const DEFAULT_DURATION   = 1.0;
	const TRIGGERS           = array( 'load', 'hover', 'scroll', 'click' );

	/**
	 * Activation: create the option. Autoloaded on purpose, because the frontend
	 * reads it on every request and it stays tiny, so no extra query is needed.
	 */
	public static function on_activate() {
		add_option( self::OPTION_KEY, array(), '', 'yes' );
	}

	/**
	 * Animation presets the builder may save. This list is the contract with the
	 * frontend engine (Step 4), which must implement every slug here.
	 *
	 * @return string[]
	 */
	public static function allowed_animations() {
		$animations = array(
			'fade-in', 'fade-up', 'fade-down', 'fade-left', 'fade-right',
			'scale-up', 'scale-down', 'spin', 'pulse', 'shake', 'flip-x', 'flip-y',
		);

		/**
		 * Filter the animation presets accepted by the save endpoint.
		 *
		 * @param string[] $animations Preset slugs.
		 */
		$filtered = apply_filters( 'kwipa_allowed_animations', $animations );

		return is_array( $filtered ) ? array_values( array_filter( $filtered, 'is_string' ) ) : $animations;
	}

	/**
	 * Read the stored config.
	 *
	 * @return array
	 */
	public static function get_config() {
		$config = get_option( self::OPTION_KEY, array() );
		return is_array( $config ) ? $config : array();
	}

	/**
	 * Persist an already-sanitized config.
	 *
	 * @param array $config Output of self::sanitize().
	 * @return bool True when the stored value now equals $config.
	 */
	public static function save( array $config ) {
		if ( self::get_config() === $config ) {
			return true;
		}
		return update_option( self::OPTION_KEY, $config, 'yes' );
	}

	/**
	 * An empty PHP array encodes as [] in JSON, but the JS side expects {}.
	 *
	 * @param array $config Config array.
	 * @return array|stdClass
	 */
	public static function as_object( array $config ) {
		return empty( $config ) ? new stdClass() : $config;
	}

	/**
	 * JSON for the inline <script> global (used by the frontend in Step 4).
	 * The HEX flags escape <, >, &, ' and " inside strings, so a stored value can
	 * never close the <script> tag or break out of the JS context.
	 *
	 * @return string
	 */
	public static function get_config_json() {
		$json = wp_json_encode(
			self::as_object( self::get_config() ),
			JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
		);
		return false === $json ? '{}' : $json;
	}

	/**
	 * Validate and sanitize a raw config from the request body.
	 * Whitelist approach: unknown triggers, animations and keys are rejected or
	 * dropped, never passed through.
	 *
	 * @param mixed $raw Decoded JSON from the client.
	 * @return array|WP_Error Clean config, or a 400 error describing the first problem.
	 */
	public static function sanitize( $raw ) {
		if ( ! is_array( $raw ) ) {
			return self::error( 'kwipa_invalid_config', __( 'The configuration must be a JSON object.', 'kwip-animation' ) );
		}
		if ( count( $raw ) > self::MAX_SELECTORS ) {
			return self::error( 'kwipa_too_many_selectors', __( 'Too many animated elements in one configuration.', 'kwip-animation' ) );
		}

		$allowed_animations = self::allowed_animations();
		$clean              = array();

		foreach ( $raw as $raw_selector => $triggers ) {
			$selector = self::sanitize_selector( (string) $raw_selector );

			if ( '' === $selector ) {
				return self::error(
					'kwipa_invalid_selector',
					__( 'One of the CSS selectors is invalid or contains disallowed characters.', 'kwip-animation' ),
					array( 'selector' => mb_substr( (string) $raw_selector, 0, 80 ) )
				);
			}
			if ( ! is_array( $triggers ) ) {
				return self::error( 'kwipa_invalid_triggers', __( 'Each element must map to an object of triggers.', 'kwip-animation' ) );
			}

			$clean_triggers = array();

			foreach ( $triggers as $trigger => $settings ) {
				if ( ! in_array( $trigger, self::TRIGGERS, true ) ) {
					return self::error( 'kwipa_invalid_trigger', __( 'Unknown trigger. Allowed: load, hover, scroll, click.', 'kwip-animation' ) );
				}
				if ( ! is_array( $settings ) ) {
					return self::error( 'kwipa_invalid_settings', __( 'Trigger settings must be an object.', 'kwip-animation' ) );
				}

				$animation = ( isset( $settings['animation'] ) && is_string( $settings['animation'] ) ) ? $settings['animation'] : '';
				if ( ! in_array( $animation, $allowed_animations, true ) ) {
					return self::error( 'kwipa_invalid_animation', __( 'Unknown animation preset.', 'kwip-animation' ) );
				}

				$entry = array(
					'animation' => $animation,
					'duration'  => self::sanitize_number( isset( $settings['duration'] ) ? $settings['duration'] : null, self::DEFAULT_DURATION, self::MAX_DURATION ),
				);

				if ( isset( $settings['delay'] ) ) {
					$entry['delay'] = self::sanitize_number( $settings['delay'], 0.0, self::MAX_DELAY );
				}

				$clean_triggers[ $trigger ] = $entry;
			}

			if ( empty( $clean_triggers ) ) {
				continue;
			}

			$clean[ $selector ] = array_merge( isset( $clean[ $selector ] ) ? $clean[ $selector ] : array(), $clean_triggers );
		}

		return $clean;
	}

	/**
	 * Strict allowlist for a single CSS selector.
	 *
	 * Allowed: letters/digits (unicode), _ - # . > + ~ : ( ) * \ / and spaces.
	 * Rejected on purpose: commas (one selector per element), quotes, brackets,
	 * angle-bracket markup, control characters, anything over MAX_SELECTOR_LEN.
	 * This guarantees safety, not full CSS validity; the engine must still wrap
	 * querySelectorAll in try/catch.
	 *
	 * @param string $selector Raw selector.
	 * @return string Clean selector, or '' when rejected.
	 */
	public static function sanitize_selector( $selector ) {
		$selector = trim( preg_replace( '/\s+/u', ' ', (string) $selector ) );

		if ( '' === $selector || strlen( $selector ) > self::MAX_SELECTOR_LEN ) {
			return '';
		}

		if ( ! preg_match( '/^[\p{L}\p{N}_\-#.>+~:()*\\\\\/ ]+$/u', $selector ) ) {
			return '';
		}

		if ( ! preg_match( '/^[\p{L}#.*_:\\\\]/u', $selector ) || preg_match( '/[>+~]$/', $selector ) ) {
			return '';
		}
		$depth = 0;
		foreach ( str_split( $selector ) as $char ) {
			if ( '(' === $char ) {
				$depth++;
			} elseif ( ')' === $char && --$depth < 0 ) {
				return '';
			}
		}

		return 0 === $depth ? $selector : '';
	}

	/**
	 * Clamp a numeric input to [0, $max], rounded to 3 decimals.
	 *
	 * @param mixed $value   Raw value.
	 * @param float $default Used when $value is not numeric.
	 * @param float $max     Upper bound.
	 * @return float
	 */
	private static function sanitize_number( $value, $default, $max ) {
		if ( ! is_numeric( $value ) ) {
			return (float) $default;
		}
		return round( min( max( (float) $value, 0.0 ), (float) $max ), 3 );
	}

	private static function error( $code, $message, $data = array() ) {
		return new WP_Error( $code, $message, array_merge( array( 'status' => 400 ), $data ) );
	}
}