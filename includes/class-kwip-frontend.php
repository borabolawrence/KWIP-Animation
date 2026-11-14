<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Public-site output. Resolves active rules for the current page path; if no
 * global or page-specific animations match, nothing is printed or enqueued.
 */
final class KWIPA_Frontend {

	private static $rules = null;

	public static function init() {
		add_action( 'wp_head', array( __CLASS__, 'print_prehide' ), 1 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/**
	 * Resolve the current public request path normalized to "/" or "/slug/".
	 *
	 * @return string
	 */
	private static function current_path() {
		$request_uri  = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		$request_path = (string) wp_parse_url( $request_uri, PHP_URL_PATH );
		$home_path    = (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH );

		if ( '' !== $home_path && '/' !== $home_path && 0 === strpos( $request_path, $home_path ) ) {
			$request_path = '/' . ltrim( substr( $request_path, strlen( $home_path ) ), '/' );
		}

		return KWIPA_Config::normalize_path( $request_path );
	}

	private static function rules() {
		if ( null === self::$rules ) {
			self::$rules = KWIPA_Config::get_active_rules( self::current_path() );
		}
		return self::$rules;
	}

	private static function should_run() {
		if ( KWIPA_Admin::is_builder_request() || is_customize_preview() ) {
			return false;
		}
		return ! empty( self::rules() );
	}

	/**
	 * Map responsive breakpoint keys to CSS @media queries so mobile elements are
	 * never hidden when an entrance animation is scoped to desktop/tablet only.
	 *
	 * @param string $breakpoint Breakpoint key.
	 * @return string
	 */
	private static function media_for_breakpoint( $breakpoint ) {
		switch ( $breakpoint ) {
			case 'desktop':
				return '(min-width:1025px)';
			case 'not-mobile':
				return '(min-width:768px)';
			case 'tablet':
				return '(min-width:768px) and (max-width:1024px)';
			case 'mobile':
				return '(max-width:767px)';
			default:
				return '';
		}
	}

	/**
	 * Pre-hide entrance animations (load and non-scrub scroll) before first paint.
	 * Effect animations start from natural state and are never hidden.
	 */
	public static function print_prehide() {
		if ( ! self::should_run() ) {
			return;
		}

		$rules = array();
		foreach ( self::rules() as $selector => $triggers ) {
			if ( ! is_array( $triggers ) ) {
				continue;
			}
			$clean = KWIPA_Config::sanitize_selector( (string) $selector );
			if ( '' === $clean ) {
				continue;
			}

			foreach ( array( 'load', 'scroll' ) as $trig_name ) {
				if ( ! isset( $triggers[ $trig_name ] ) || ! is_array( $triggers[ $trig_name ] ) ) {
					continue;
				}
				$settings = $triggers[ $trig_name ];
				if ( 'scroll' === $trig_name && ! empty( $settings['scroll']['scrub'] ) ) {
					continue;
				}
				$motion = isset( $settings['animation'] ) ? KWIPA_Motions::get( $settings['animation'] ) : null;
				if ( ! $motion || 'entrance' !== $motion['kind'] ) {
					continue;
				}

				$rule  = '.kwipa-js ' . $clean . '{visibility:hidden;animation:kwipa-reveal 0s linear 2s forwards}';
				$media = isset( $settings['breakpoint'] ) ? self::media_for_breakpoint( $settings['breakpoint'] ) : '';
				$rules[] = '' !== $media ? '@media ' . $media . '{' . $rule . '}' : $rule;
				break;
			}
		}

		if ( empty( $rules ) ) {
			return;
		}

		echo '<script id="kwipa-flag">document.documentElement.className+=" kwipa-js";</script>' . "\n";
		echo '<style id="kwipa-prehide">@media (prefers-reduced-motion:no-preference){@keyframes kwipa-reveal{to{visibility:visible}}' . implode( '', $rules ) . "}</style>\n";
	}

	public static function enqueue() {
		if ( ! self::should_run() ) {
			return;
		}

		$active     = self::rules();
		$has_scroll = false;
		$slugs      = array();

		foreach ( $active as $triggers ) {
			if ( ! is_array( $triggers ) ) {
				continue;
			}
			foreach ( $triggers as $trigger => $settings ) {
				if ( 'scroll' === $trigger ) {
					$has_scroll = true;
				}
				if ( is_array( $settings ) && isset( $settings['animation'] ) ) {
					$slugs[] = $settings['animation'];
				}
				if ( is_array( $settings ) && ! empty( $settings['steps'] ) && is_array( $settings['steps'] ) ) {
					foreach ( $settings['steps'] as $step ) {
						if ( is_array( $step ) && isset( $step['animation'] ) ) {
							$slugs[] = $step['animation'];
						}
					}
				}
			}
		}

		KWIPA_Assets::register( $has_scroll );

		$motions = KWIPA_Motions::client_payload( array_values( array_unique( $slugs ) ) );

		wp_add_inline_script(
			'kwipa-engine',
			'window.KWIPAMotions = ' . KWIPA_Config::encode( $motions ) . ';window.KWIPAnimationConfig = ' . KWIPA_Config::encode( $active ) . ';',
			'before'
		);
		wp_enqueue_script( 'kwipa-engine' );
	}
}