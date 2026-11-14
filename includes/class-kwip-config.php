<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Storage, validation, scoping, and serialization of the animation config.
 *
 * Schema v2:
 * {
 *   "version": 2,
 *   "scopes": {
 *     "global": { ".btn": { "hover": { ... } } },
 *     "path:/": { ".hero-title": { "load": { ... } } }
 *   }
 * }
 */
final class KWIPA_Config {

	const OPTION_KEY       = 'kwipa_animation_config';
	const SCHEMA_VERSION   = 2;
	const MAX_SCOPES       = 100;
	const MAX_SELECTORS    = 500;
	const MAX_SELECTOR_LEN = 255;
	const MAX_STEPS        = 8;
	const MAX_DURATION     = 30.0;
	const MAX_DELAY        = 30.0;
	const MAX_STAGGER      = 5.0;
	const DEFAULT_DURATION = 1.0;
	const TRIGGERS         = array( 'load', 'hover', 'scroll', 'click' );

	const STEP_POSITIONS = array(
		'>'      => 'After previous',
		'<'      => 'With previous (simultaneous)',
		'-=0.15' => 'Overlap 0.15s',
		'-=0.3'  => 'Overlap 0.30s',
		'+=0.2'  => 'Pause 0.20s',
		'+=0.5'  => 'Pause 0.50s',
	);

	const EASES = array(
		''                   => 'Preset default',
		'power2.out'         => 'Power2 Out (Smooth)',
		'power3.out'         => 'Power3 Out (Snappy)',
		'power4.out'         => 'Power4 Out (Dramatic)',
		'power2.inOut'       => 'Power2 In-Out',
		'expo.out'           => 'Expo Out',
		'circ.out'           => 'Circ Out',
		'back.out(1.7)'      => 'Back Out (Overshoot)',
		'elastic.out(1,0.3)' => 'Elastic Out',
		'bounce.out'         => 'Bounce Out',
		'sine.inOut'         => 'Sine In-Out',
		'none'               => 'Linear (None)',
	);

	const BREAKPOINTS = array(
		'all'        => 'All devices',
		'desktop'    => 'Desktop (> 1024px)',
		'not-mobile' => 'Tablet & Desktop (>= 768px)',
		'tablet'     => 'Tablet (768px - 1024px)',
		'mobile'     => 'Mobile (< 768px)',
	);

	const SCROLL_STARTS = array(
		'top 85%'       => 'Top 85% (Default)',
		'top 95%'       => 'Top 95% (Early)',
		'top 70%'       => 'Top 70% (Mid-low)',
		'top 50%'       => 'Top 50% (Viewport center)',
		'center center' => 'Center Center',
		'top top'       => 'Top Top (Sticky/Pin)',
		'top bottom'    => 'Top Bottom (Full travel)',
	);

	const SCROLL_ENDS = array(
		'bottom 20%'    => 'Bottom 20% (Default)',
		'bottom top'    => 'Bottom Top (Exit viewport)',
		'center center' => 'Center Center',
		'+=300'         => '+300px scroll distance',
		'+=500'         => '+500px scroll distance',
		'+=100%'        => '+100% viewport height',
		'+=200%'        => '+200% viewport height',
	);

	const TOGGLE_ACTIONS = array(
		'play none none none'         => 'Play once (Default)',
		'play reverse play reverse'   => 'Play & reverse on leave',
		'play pause resume reset'     => 'Play, pause & reset',
		'restart none none none'      => 'Restart every enter',
		'play complete reverse reset' => 'Complete & reverse',
	);

	public static function on_activate() {
		add_option(
			self::OPTION_KEY,
			array(
				'version' => self::SCHEMA_VERSION,
				'scopes'  => array(),
			),
			'',
			'no'
		);
	}

	/**
	 * @return string[]
	 */
	public static function allowed_animations() {
		$animations = array_map( 'strval', array_keys( KWIPA_Motions::all() ) );
		$filtered   = apply_filters( 'kwipa_allowed_animations', $animations );

		return is_array( $filtered ) ? array_values( array_filter( $filtered, 'is_string' ) ) : $animations;
	}

	/**
	 * Normalize a URL path so "/", "/about", and "/about/" resolve consistently.
	 *
	 * @param string $path Raw path.
	 * @return string
	 */
	public static function normalize_path( $path ) {
		$parsed = wp_parse_url( (string) $path, PHP_URL_PATH );
		$clean  = '/' . trim( (string) $parsed, '/' );
		return '/' === $clean ? '/' : $clean . '/';
	}

	/**
	 * Validate a scope key ("global" or "path:/...").
	 *
	 * @param string $scope Raw scope key.
	 * @return string Clean scope key, or '' when invalid.
	 */
	public static function sanitize_scope_key( $scope ) {
		$scope = trim( (string) $scope );
		if ( 'global' === $scope ) {
			return 'global';
		}
		if ( 0 !== strpos( $scope, 'path:' ) ) {
			return '';
		}
		$raw_path = substr( $scope, 5 );
		if ( '' === $raw_path || strlen( $raw_path ) > 190 || false !== strpos( $raw_path, '..' ) ) {
			return '';
		}
		if ( ! preg_match( '/^\/[a-zA-Z0-9_.\/-]*$/', $raw_path ) ) {
			return '';
		}
		return 'path:' . self::normalize_path( $raw_path );
	}

	/**
	 * Read the stored v2 scoped config, transparently upgrading legacy v1 flat maps.
	 *
	 * @return array{version:int,scopes:array<string,array>}
	 */
	public static function get_scoped_config() {
		$raw = get_option( self::OPTION_KEY, array() );
		if ( ! is_array( $raw ) || empty( $raw ) ) {
			return array(
				'version' => self::SCHEMA_VERSION,
				'scopes'  => array(),
			);
		}

		if ( isset( $raw['scopes'] ) && is_array( $raw['scopes'] ) ) {
			return array(
				'version' => self::SCHEMA_VERSION,
				'scopes'  => $raw['scopes'],
			);
		}

		// Legacy v1 flat format: treat as global rules.
		return array(
			'version' => self::SCHEMA_VERSION,
			'scopes'  => array(
				'global' => $raw,
			),
		);
	}

	/**
	 * Return merged selector => triggers rules active for a specific path.
	 * Page-scoped rules override global rules for the same selector.
	 *
	 * @param string|null $path Current page path (normalized).
	 * @return array<string,array>
	 */
	public static function get_active_rules( $path = null ) {
		$scoped = self::get_scoped_config();
		$scopes = $scoped['scopes'];
		$rules  = ( isset( $scopes['global'] ) && is_array( $scopes['global'] ) ) ? $scopes['global'] : array();

		if ( null !== $path ) {
			$page_key = 'path:' . self::normalize_path( $path );
			if ( isset( $scopes[ $page_key ] ) && is_array( $scopes[ $page_key ] ) ) {
				foreach ( $scopes[ $page_key ] as $selector => $triggers ) {
					if ( ! is_array( $triggers ) ) {
						continue;
					}
					$rules[ $selector ] = isset( $rules[ $selector ] ) && is_array( $rules[ $selector ] )
						? array_merge( $rules[ $selector ], $triggers )
						: $triggers;
				}
			}
		}

		return $rules;
	}

	/**
	 * Persist an already-sanitized v2 scoped config.
	 *
	 * @param array $config Output of self::sanitize().
	 * @return bool
	 */
	public static function save( array $config ) {
		if ( self::get_scoped_config() === $config ) {
			return true;
		}
		return update_option( self::OPTION_KEY, $config, 'no' );
	}

	/**
	 * Ensure empty scopes encode as {} instead of [] in JSON.
	 *
	 * @param array $scoped Scoped config array.
	 * @return array
	 */
	public static function as_scoped_object( array $scoped ) {
		$scopes = array();
		if ( ! empty( $scoped['scopes'] ) && is_array( $scoped['scopes'] ) ) {
			foreach ( $scoped['scopes'] as $key => $rules ) {
				if ( is_array( $rules ) && ! empty( $rules ) ) {
					$scopes[ $key ] = $rules;
				}
			}
		}

		return array(
			'version' => self::SCHEMA_VERSION,
			'scopes'  => empty( $scopes ) ? new stdClass() : $scopes,
		);
	}

	/**
	 * @param mixed $data Array or object.
	 * @return string
	 */
	public static function encode( $data ) {
		$json = wp_json_encode(
			empty( $data ) ? new stdClass() : $data,
			JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
		);
		return false === $json ? '{}' : $json;
	}

	/**
	 * Validate and sanitize a raw v2 scoped config (or legacy v1 flat map).
	 *
	 * @param mixed $raw Decoded JSON from the client.
	 * @return array{version:int,scopes:array}|WP_Error
	 */
	public static function sanitize( $raw ) {
		if ( ! is_array( $raw ) ) {
			return self::error( 'kwipa_invalid_config', __( 'The configuration must be a JSON object.', 'kwip-animation' ) );
		}

		$raw_scopes = ( isset( $raw['scopes'] ) && is_array( $raw['scopes'] ) )
			? $raw['scopes']
			: ( empty( $raw ) ? array() : array( 'global' => $raw ) );

		if ( count( $raw_scopes ) > self::MAX_SCOPES ) {
			return self::error( 'kwipa_too_many_scopes', __( 'Too many page scopes in one configuration.', 'kwip-animation' ) );
		}

		$allowed_animations = self::allowed_animations();
		$clean_scopes       = array();

		foreach ( $raw_scopes as $raw_scope => $selectors ) {
			$scope_key = self::sanitize_scope_key( (string) $raw_scope );
			if ( '' === $scope_key ) {
				return self::error( 'kwipa_invalid_scope', __( 'Invalid page scope key.', 'kwip-animation' ) );
			}
			if ( ! is_array( $selectors ) ) {
				return self::error( 'kwipa_invalid_scope_rules', __( 'Each scope must map to an object of selectors.', 'kwip-animation' ) );
			}

			$clean_rules = self::sanitize_rule_map( $selectors, $allowed_animations );
			if ( is_wp_error( $clean_rules ) ) {
				return $clean_rules;
			}
			if ( ! empty( $clean_rules ) ) {
				$clean_scopes[ $scope_key ] = $clean_rules;
			}
		}

		return array(
			'version' => self::SCHEMA_VERSION,
			'scopes'  => $clean_scopes,
		);
	}

	/**
	 * @param array    $raw                Map of selector => triggers.
	 * @param string[] $allowed_animations Allowed motion slugs.
	 * @return array|WP_Error
	 */
	private static function sanitize_rule_map( array $raw, array $allowed_animations ) {
		if ( count( $raw ) > self::MAX_SELECTORS ) {
			return self::error( 'kwipa_too_many_selectors', __( 'Too many animated elements in one scope.', 'kwip-animation' ) );
		}

		$clean = array();

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
				$motion    = in_array( $animation, $allowed_animations, true ) ? KWIPA_Motions::get( $animation ) : null;
				if ( null === $motion ) {
					return self::error( 'kwipa_invalid_animation', __( 'Unknown animation preset.', 'kwip-animation' ) );
				}

				$entry = array(
					'animation' => $animation,
					'duration'  => self::sanitize_number( isset( $settings['duration'] ) ? $settings['duration'] : null, self::DEFAULT_DURATION, self::MAX_DURATION ),
				);

				if ( isset( $settings['delay'] ) ) {
					$delay = self::sanitize_number( $settings['delay'], 0.0, self::MAX_DELAY );
					if ( $delay > 0 ) {
						$entry['delay'] = $delay;
					}
				}

				if ( isset( $settings['stagger'] ) ) {
					$stagger = self::sanitize_number( $settings['stagger'], 0.0, self::MAX_STAGGER );
					if ( $stagger > 0 ) {
						$entry['stagger'] = $stagger;
					}
				}

				if ( isset( $settings['ease'] ) && is_string( $settings['ease'] ) && '' !== $settings['ease'] ) {
					if ( ! preg_match( KWIPA_Motions::EASE_PATTERN, $settings['ease'] ) ) {
						return self::error( 'kwipa_invalid_ease', __( 'Invalid GSAP easing value.', 'kwip-animation' ) );
					}
					$entry['ease'] = $settings['ease'];
				}

				if ( isset( $settings['breakpoint'] ) && is_string( $settings['breakpoint'] ) && 'all' !== $settings['breakpoint'] ) {
					if ( ! isset( self::BREAKPOINTS[ $settings['breakpoint'] ] ) ) {
						return self::error( 'kwipa_invalid_breakpoint', __( 'Unknown responsive breakpoint.', 'kwip-animation' ) );
					}
					$entry['breakpoint'] = $settings['breakpoint'];
				}

				if ( ! empty( $motion['params'] ) && isset( $settings['params'] ) && is_array( $settings['params'] ) ) {
					$params = array();
					foreach ( $motion['params'] as $param => $spec ) {
						if ( isset( $settings['params'][ $param ] ) && is_numeric( $settings['params'][ $param ] ) ) {
							$params[ $param ] = round( min( max( (float) $settings['params'][ $param ], $spec['min'] ), $spec['max'] ), 3 );
						}
					}
					if ( $params ) {
						$entry['params'] = $params;
					}
				}

				if ( 'scroll' === $trigger && isset( $settings['scroll'] ) && is_array( $settings['scroll'] ) ) {
					$scroll = self::sanitize_scroll( $settings['scroll'] );
					if ( is_wp_error( $scroll ) ) {
						return $scroll;
					}
					if ( ! empty( $scroll ) ) {
						$entry['scroll'] = $scroll;
					}
				}

				if ( isset( $settings['steps'] ) && is_array( $settings['steps'] ) && ! empty( $settings['steps'] ) ) {
					$steps = self::sanitize_steps( $settings['steps'], $allowed_animations );
					if ( is_wp_error( $steps ) ) {
						return $steps;
					}
					if ( ! empty( $steps ) ) {
						$entry['steps'] = $steps;
					}
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
	 * Validate ScrollTrigger options (start, end, scrub, pin, toggleActions, trigger).
	 *
	 * @param array $raw Raw scroll settings.
	 * @return array|WP_Error
	 */
	private static function sanitize_scroll( array $raw ) {
		$out = array();

		if ( isset( $raw['start'] ) && is_string( $raw['start'] ) && '' !== $raw['start'] ) {
			if ( ! preg_match( '/^(top|center|bottom|\d{1,3}%|\d{1,4}px)\s+(top|center|bottom|\d{1,3}%|\d{1,4}px|[+-]=\d{1,4}(px|%)?)$/', $raw['start'] ) ) {
				return self::error( 'kwipa_invalid_scroll_start', __( 'Invalid ScrollTrigger start value.', 'kwip-animation' ) );
			}
			if ( 'top 85%' !== $raw['start'] ) {
				$out['start'] = $raw['start'];
			}
		}

		if ( isset( $raw['end'] ) && is_string( $raw['end'] ) && '' !== $raw['end'] ) {
			if ( ! preg_match( '/^((top|center|bottom|\d{1,3}%|\d{1,4}px)\s+(top|center|bottom|\d{1,3}%|\d{1,4}px)|[+-]=\d{1,4}(px|%)?)$/', $raw['end'] ) ) {
				return self::error( 'kwipa_invalid_scroll_end', __( 'Invalid ScrollTrigger end value.', 'kwip-animation' ) );
			}
			if ( 'bottom 20%' !== $raw['end'] ) {
				$out['end'] = $raw['end'];
			}
		}

		if ( isset( $raw['scrub'] ) ) {
			if ( true === $raw['scrub'] ) {
				$out['scrub'] = true;
			} elseif ( is_numeric( $raw['scrub'] ) && (float) $raw['scrub'] > 0 ) {
				$out['scrub'] = round( min( (float) $raw['scrub'], 10.0 ), 2 );
			}
		}

		if ( isset( $raw['pin'] ) && true === $raw['pin'] ) {
			$out['pin'] = true;
		}

		if ( isset( $raw['toggleActions'] ) && is_string( $raw['toggleActions'] ) && '' !== $raw['toggleActions'] ) {
			if ( ! isset( self::TOGGLE_ACTIONS[ $raw['toggleActions'] ] ) ) {
				return self::error( 'kwipa_invalid_toggle_actions', __( 'Invalid ScrollTrigger toggleActions.', 'kwip-animation' ) );
			}
			if ( 'play none none none' !== $raw['toggleActions'] ) {
				$out['toggleActions'] = $raw['toggleActions'];
			}
		}

		if ( isset( $raw['trigger'] ) && is_string( $raw['trigger'] ) && '' !== trim( $raw['trigger'] ) ) {
			$trig = self::sanitize_selector( $raw['trigger'] );
			if ( '' === $trig ) {
				return self::error( 'kwipa_invalid_scroll_trigger', __( 'Invalid ScrollTrigger target selector.', 'kwip-animation' ) );
			}
			$out['trigger'] = $trig;
		}

		return $out;
	}


	/**
	 * Validate chained timeline steps (steps 2..N after the primary trigger motion).
	 *
	 * @param array    $raw_steps          Raw step objects.
	 * @param string[] $allowed_animations Allowed motion slugs.
	 * @return array[]|WP_Error
	 */
	private static function sanitize_steps( array $raw_steps, array $allowed_animations ) {
		if ( count( $raw_steps ) > self::MAX_STEPS ) {
			return self::error( 'kwipa_too_many_steps', __( 'Too many timeline steps on one trigger.', 'kwip-animation' ) );
		}

		$clean = array();

		foreach ( $raw_steps as $step ) {
			if ( ! is_array( $step ) ) {
				return self::error( 'kwipa_invalid_step', __( 'Each timeline step must be an object.', 'kwip-animation' ) );
			}

			$animation = ( isset( $step['animation'] ) && is_string( $step['animation'] ) ) ? $step['animation'] : '';
			$motion    = in_array( $animation, $allowed_animations, true ) ? KWIPA_Motions::get( $animation ) : null;
			if ( null === $motion ) {
				return self::error( 'kwipa_invalid_animation', __( 'Unknown animation preset in timeline step.', 'kwip-animation' ) );
			}

			$entry = array(
				'animation' => $animation,
				'duration'  => self::sanitize_number( isset( $step['duration'] ) ? $step['duration'] : null, 0.6, self::MAX_DURATION ),
			);

			if ( isset( $step['target'] ) && is_string( $step['target'] ) ) {
				$target = trim( preg_replace( '/\s+/', ' ', $step['target'] ) );
				if ( '' !== $target ) {
					if ( strlen( $target ) > self::MAX_SELECTOR_LEN || false !== strpos( $target, '</' ) || ! preg_match( '/^[\p{L}\p{N}_\-#.>+~:()*\[\]="\'^$|~\\\/ ]+$/u', $target ) ) {
						return self::error( 'kwipa_invalid_step_target', __( 'Invalid CSS selector in timeline step.', 'kwip-animation' ) );
					}
					$entry['target'] = $target;
				}
			}

			if ( isset( $step['position'] ) && is_string( $step['position'] ) && '' !== $step['position'] && '>' !== $step['position'] ) {
				if ( ! preg_match( '/^(>|<|[+-]=\d{1,2}(\.\d{1,2})?)$/', $step['position'] ) ) {
					return self::error( 'kwipa_invalid_step_position', __( 'Invalid timeline step offset.', 'kwip-animation' ) );
				}
				$entry['position'] = $step['position'];
			}

			if ( isset( $step['ease'] ) && is_string( $step['ease'] ) && '' !== $step['ease'] ) {
				if ( ! preg_match( KWIPA_Motions::EASE_PATTERN, $step['ease'] ) ) {
					return self::error( 'kwipa_invalid_ease', __( 'Invalid GSAP easing value.', 'kwip-animation' ) );
				}
				$entry['ease'] = $step['ease'];
			}

			if ( ! empty( $motion['params'] ) && isset( $step['params'] ) && is_array( $step['params'] ) ) {
				$params = array();
				foreach ( $motion['params'] as $param => $spec ) {
					if ( isset( $step['params'][ $param ] ) && is_numeric( $step['params'][ $param ] ) ) {
						$params[ $param ] = round( min( max( (float) $step['params'][ $param ], $spec['min'] ), $spec['max'] ), 3 );
					}
				}
				if ( $params ) {
					$entry['params'] = $params;
				}
			}

			$clean[] = $entry;
		}

		return $clean;
	}

	/**
	 * Strict allowlist for a single CSS selector, including safe [attr] / [attr="val"] tokens.
	 *
	 * @param string $selector Raw selector.
	 * @return string
	 */
	public static function sanitize_selector( $selector ) {
		$selector = trim( preg_replace( '/\s+/u', ' ', (string) $selector ) );

		if ( '' === $selector || strlen( $selector ) > self::MAX_SELECTOR_LEN ) {
			return '';
		}

		if ( false !== stripos( $selector, '</' ) ) {
			return '';
		}

		$without_attrs = preg_replace_callback(
			'/\[[^\]]*\]/',
			function ( $m ) {
				return preg_match( '/^\[[a-zA-Z][a-zA-Z0-9_-]*(?:[~|^$*]?="[a-zA-Z0-9 _.:-]{1,64}")?\]$/', $m[0] )
					? '__ATTR__'
					: '!!INVALID!!';
			},
			$selector
		);

		if ( null === $without_attrs || false !== strpos( $without_attrs, '!!INVALID!!' ) ) {
			return '';
		}

		if ( false !== strpos( $without_attrs, '[' ) || false !== strpos( $without_attrs, ']' ) ) {
			return '';
		}

		if ( ! preg_match( '/^[\p{L}\p{N}_\-#.>+~:()*\\\\\/ ]+$/u', $without_attrs ) ) {
			return '';
		}

		if ( ! preg_match( '/^[\p{L}#.*_:\\\\]/u', $without_attrs ) || preg_match( '/[>+~\\\\]$/', $without_attrs ) ) {
			return '';
		}

		$depth = 0;
		foreach ( str_split( $without_attrs ) as $char ) {
			if ( '(' === $char ) {
				$depth++;
			} elseif ( ')' === $char && --$depth < 0 ) {
				return '';
			}
		}

		return 0 === $depth ? $selector : '';
	}

	/**
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