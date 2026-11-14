<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Motion registry: validates motion packs (schema 1) and serves their motions.
 *
 * Built-in packs live in /motions/*.json and register bare slugs ("fade-up").
 * Installed packs live in an option and register "pack-id/motion" slugs.
 * Packs are data only: every value is checked against allowlists below, so a
 * pack can never inject script, arbitrary CSS or unbounded numbers.
 */
final class KWIPA_Motions {

	const SCHEMA_VERSION = 1;
	const OPTION_KEY     = 'kwipa_motion_packs';
	const MAX_PACKS      = 20;
	const MAX_MOTIONS    = 100;
	const MAX_PROPS      = 8;
	const MAX_PARAMS     = 6;
	const NAME_PATTERN   = '/^[a-z0-9]+(-[a-z0-9]+)*$/';
	const PACK_KEYS      = array( 'schema', 'id', 'name', 'version', 'author', 'description', 'motions' );
	const MOTION_KEYS    = array( 'label', 'group', 'kind', 'glyph', 'from', 'to', 'keyframes', 'ease', 'legs', 'hold', 'params' );
	const GLYPHS = array( 'fade-in', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'scale-up', 'scale-down', 'pulse', 'spin', 'flip-x', 'flip-y', 'shake' );
	const PARAM_UNITS    = array( '', 'px', '%', 'deg', 's', 'x' );

	const EASE_PATTERN = '/^(none|linear|(power[1-4]|sine|expo|circ|back|elastic|bounce)\.(in|out|inOut)(\(\s*\d{1,3}(\.\d{1,3})?(\s*,\s*\d{1,3}(\.\d{1,3})?)?\s*\))?|steps\(\s*\d{1,3}\s*\))$/';

	const NUMERIC_PROPS = array(
		'opacity'              => array( 0, 1 ),
		'autoAlpha'            => array( 0, 1 ),
		'x'                    => array( -5000, 5000 ),
		'y'                    => array( -5000, 5000 ),
		'z'                    => array( -5000, 5000 ),
		'xPercent'             => array( -1000, 1000 ),
		'yPercent'             => array( -1000, 1000 ),
		'scale'                => array( -20, 20 ),
		'scaleX'               => array( -20, 20 ),
		'scaleY'               => array( -20, 20 ),
		'rotation'             => array( -3600, 3600 ),
		'rotationX'            => array( -3600, 3600 ),
		'rotationY'            => array( -3600, 3600 ),
		'rotationZ'            => array( -3600, 3600 ),
		'skewX'                => array( -180, 180 ),
		'skewY'                => array( -180, 180 ),
		'transformPerspective' => array( 0, 5000 ),
	);

	const STRING_PROPS = array(
		'transformOrigin' => '/^(left|center|right|top|bottom|\d{1,3}(\.\d+)?%)( (left|center|right|top|bottom|\d{1,3}(\.\d+)?%)){0,2}$/',
		'clipPath'        => '/^(inset|circle|ellipse|polygon)\([0-9a-z.%\s,\-]{1,160}\)$/i',
		'filter'          => '/^(blur\(\d{1,2}(\.\d+)?px\)|brightness\(\d(\.\d+)?\))$/',
		'color'           => '/^#[0-9a-fA-F]{3,8}$/',
		'backgroundColor' => '/^#[0-9a-fA-F]{3,8}$/',
	);

	private static $builtin = null;
	private static $builtin_packs = array();
	private static $installed = null;
	private static $installed_motions = null;

	/**
	 * Every motion, built-in first.
	 *
	 * @return array slug => motion
	 */
	public static function all() {
		return array_merge( self::builtin(), self::installed_motions() );
	}

	/**
	 * One motion by slug. Installed packs are only loaded when the slug needs
	 * them (it contains "/"), so sites that use core motions never read that option.
	 *
	 * @param mixed $slug Motion slug.
	 * @return array|null
	 */
	public static function get( $slug ) {
		if ( ! is_string( $slug ) ) {
			return null;
		}
		$pool = false === strpos( $slug, '/' ) ? self::builtin() : self::installed_motions();
		return isset( $pool[ $slug ] ) ? $pool[ $slug ] : null;
	}

	/**
	 * What the browser engine needs, nothing more. Pass slugs to "tree-shake" to
	 * just the motions a page uses, or null for the full library (builder iframe).
	 *
	 * @param string[]|null $slugs Motion slugs.
	 * @return array slug => client definition
	 */
	public static function client_payload( $slugs = null ) {
		$source = null === $slugs ? self::all() : array();
		if ( null !== $slugs ) {
			foreach ( $slugs as $slug ) {
				$motion = self::get( $slug );
				if ( $motion ) {
					$source[ $slug ] = $motion;
				}
			}
		}

		$out = array();
		foreach ( $source as $slug => $motion ) {
			$def = array( 'kind' => $motion['kind'] );
			foreach ( array( 'from', 'to', 'keyframes', 'ease', 'legs', 'hold' ) as $key ) {
				if ( isset( $motion[ $key ] ) ) {
					$def[ $key ] = $motion[ $key ];
				}
			}
			if ( ! empty( $motion['params'] ) ) {
				$def['params'] = array();
				foreach ( $motion['params'] as $name => $spec ) {
					$def['params'][ $name ] = array(
						'default' => $spec['default'],
						'min'     => $spec['min'],
						'max'     => $spec['max'],
					);
				}
			}
			$out[ $slug ] = $def;
		}
		return $out;
	}

	/**
	 * Metadata for the admin UI (labels, groups, parameter specs).
	 *
	 * @return array slug => meta
	 */
	public static function admin_meta() {
		$out = array();
		foreach ( self::all() as $slug => $motion ) {
			$out[ $slug ] = array(
				'label'  => $motion['label'],
				'group'  => $motion['group'],
				'pack'   => $motion['pack'],
				'glyph'  => self::glyph_of( $slug, $motion ),
				'params' => isset( $motion['params'] ) ? $motion['params'] : new stdClass(),
			);
		}
		return $out;
	}

	private static function glyph_of( $slug, array $motion ) {
		if ( isset( $motion['glyph'] ) ) {
			return $motion['glyph'];
		}
		if ( in_array( $slug, self::GLYPHS, true ) ) {
			return $slug;
		}
		return 'entrance' === $motion['kind'] ? 'fade-in' : 'pulse';
	}

	private static function builtin() {
		if ( null !== self::$builtin ) {
			return self::$builtin;
		}
		self::$builtin       = array();
		self::$builtin_packs = array();

		foreach ( (array) glob( KWIPA_PATH . 'motions/*.json' ) as $file ) {
			$json = file_get_contents( $file );

			$json = is_string( $json ) ? preg_replace( '/^\xEF\xBB\xBF/', '', $json ) : null;
			$pack = self::sanitize_pack( is_string( $json ) ? json_decode( $json, true ) : null );

			if ( is_wp_error( $pack ) ) {
				if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
					error_log( 'KWIP Animation: skipped ' . basename( $file ) . ': ' . $pack->get_error_message() );
				}
				continue;
			}

			self::$builtin_packs[] = $pack;
			foreach ( $pack['motions'] as $name => $motion ) {
				self::$builtin[ $name ] = self::decorate( $motion, $pack['id'] );
			}
		}
		return self::$builtin;
	}

	public static function installed() {
		if ( null === self::$installed ) {
			$packs           = get_option( self::OPTION_KEY, array() );
			self::$installed = is_array( $packs ) ? $packs : array();
		}
		return self::$installed;
	}

	private static function installed_motions() {
		if ( null !== self::$installed_motions ) {
			return self::$installed_motions;
		}
		self::$installed_motions = array();

		foreach ( self::installed() as $pack ) {
			if ( ! is_array( $pack ) || empty( $pack['id'] ) || empty( $pack['motions'] ) || ! is_array( $pack['motions'] ) ) {
				continue;
			}
			foreach ( $pack['motions'] as $name => $motion ) {
				if ( is_array( $motion ) ) {
					self::$installed_motions[ $pack['id'] . '/' . $name ] = self::decorate( $motion, $pack['id'] );
				}
			}
		}
		return self::$installed_motions;
	}

	
	

	private static function decorate( array $motion, $pack_id ) {
		$motion['pack'] = $pack_id;
		return $motion;
	}

	private static function reset() {
		self::$installed         = null;
		self::$installed_motions = null;
	}

	/**
	 * @param array $raw Decoded pack JSON.
	 * @return array|WP_Error The stored (sanitized) pack.
	 */
	public static function install( $raw ) {
		$pack = self::sanitize_pack( $raw );
		if ( is_wp_error( $pack ) ) {
			return $pack;
		}
		if ( 0 === strpos( $pack['id'], 'kwip-' ) ) {
			return self::err( __( 'Pack ids starting with "kwip-" are reserved for built-in packs.', 'kwip-animation' ) );
		}

		$packs = self::installed();
		if ( ! isset( $packs[ $pack['id'] ] ) && count( $packs ) >= self::MAX_PACKS ) {
			return self::err( __( 'Too many motion packs are installed. Remove one first.', 'kwip-animation' ) );
		}

		$packs[ $pack['id'] ] = $pack;
		update_option( self::OPTION_KEY, $packs, false );
		self::reset();

		do_action( 'kwipa_motions_changed' );

		return $pack;
	}

	/**
	 * @param string $id Pack id.
	 * @return true|WP_Error
	 */
	public static function remove( $id ) {
		$packs = self::installed();
		if ( ! isset( $packs[ $id ] ) ) {
			return new WP_Error( 'kwipa_pack_missing', __( 'That motion pack is not installed.', 'kwip-animation' ), array( 'status' => 404 ) );
		}
		unset( $packs[ $id ] );
		update_option( self::OPTION_KEY, $packs, false );
		self::reset();

		do_action( 'kwipa_motions_changed' );
		return true;
	}

	/**
	 * @param mixed $raw Decoded pack JSON.
	 * @return array|WP_Error Normalized pack, or an error naming the first problem.
	 */
	public static function sanitize_pack( $raw ) {
		if ( ! is_array( $raw ) ) {
			return self::err( __( 'A motion pack must be a JSON object.', 'kwip-animation' ) );
		}
		if ( ! isset( $raw['schema'] ) || self::SCHEMA_VERSION !== $raw['schema'] ) {
			return self::err( __( 'Unsupported motion pack schema. This version reads schema 1.', 'kwip-animation' ) );
		}
		$unknown = array_diff( array_keys( $raw ), self::PACK_KEYS );
		if ( $unknown ) {
			return self::err( sprintf( __( 'Unknown pack field "%s".', 'kwip-animation' ), self::short( reset( $unknown ) ) ) );
		}

		$id = ( isset( $raw['id'] ) && is_string( $raw['id'] ) ) ? $raw['id'] : '';
		if ( ! preg_match( self::NAME_PATTERN, $id ) || strlen( $id ) > 40 ) {
			return self::err( __( 'The pack id must be lowercase letters, digits and hyphens (max 40).', 'kwip-animation' ) );
		}

		$name = self::text( isset( $raw['name'] ) ? $raw['name'] : '', 60 );
		if ( '' === $name ) {
			return self::err( __( 'The pack needs a name (max 60 characters).', 'kwip-animation' ) );
		}

		$version = ( isset( $raw['version'] ) && is_string( $raw['version'] ) ) ? $raw['version'] : '';
		if ( ! preg_match( '/^\d{1,3}\.\d{1,3}\.\d{1,3}$/', $version ) ) {
			return self::err( __( 'The pack version must look like 1.0.0.', 'kwip-animation' ) );
		}

		if ( ! isset( $raw['motions'] ) || ! is_array( $raw['motions'] ) || empty( $raw['motions'] ) || count( $raw['motions'] ) > self::MAX_MOTIONS ) {
			return self::err( __( 'A pack needs between 1 and 100 motions.', 'kwip-animation' ) );
		}

		$motions = array();
		foreach ( $raw['motions'] as $motion_name => $motion ) {
			$motion_name = (string) $motion_name;
			if ( ! preg_match( self::NAME_PATTERN, $motion_name ) || strlen( $motion_name ) > 40 ) {
				return self::err( sprintf( __( 'Invalid motion name "%s". Use lowercase letters, digits and hyphens.', 'kwip-animation' ), self::short( $motion_name ) ) );
			}
			$clean = self::sanitize_motion( $motion, $motion_name );
			if ( is_wp_error( $clean ) ) {
				return $clean;
			}
			$motions[ $motion_name ] = $clean;
		}

		return array(
			'schema'      => self::SCHEMA_VERSION,
			'id'          => $id,
			'name'        => $name,
			'version'     => $version,
			'author'      => self::text( isset( $raw['author'] ) ? $raw['author'] : '', 60 ),
			'description' => self::text( isset( $raw['description'] ) ? $raw['description'] : '', 200 ),
			'motions'     => $motions,
		);
	}

	private static function sanitize_motion( $raw, $name ) {
		if ( ! is_array( $raw ) ) {
			return self::motion_err( $name, __( 'must be an object.', 'kwip-animation' ) );
		}
		$unknown = array_diff( array_keys( $raw ), self::MOTION_KEYS );
		if ( $unknown ) {
			return self::motion_err( $name, sprintf( __( 'has an unknown field "%s".', 'kwip-animation' ), self::short( reset( $unknown ) ) ) );
		}

		$label = self::text( isset( $raw['label'] ) ? $raw['label'] : '', 40 );
		if ( '' === $label ) {
			return self::motion_err( $name, __( 'needs a label (max 40 characters).', 'kwip-animation' ) );
		}
		$group = self::text( isset( $raw['group'] ) ? $raw['group'] : '', 30 );
		$kind  = ( isset( $raw['kind'] ) && is_string( $raw['kind'] ) ) ? $raw['kind'] : '';
		if ( ! in_array( $kind, array( 'entrance', 'effect' ), true ) ) {
			return self::motion_err( $name, __( 'kind must be "entrance" or "effect".', 'kwip-animation' ) );
		}
		$glyph = '';
		if ( isset( $raw['glyph'] ) ) {
			if ( ! is_string( $raw['glyph'] ) || ! in_array( $raw['glyph'], self::GLYPHS, true ) ) {
				return self::motion_err( $name, __( 'uses an unknown glyph.', 'kwip-animation' ) );
			}
			$glyph = $raw['glyph'];
		}

		$params = array();
		if ( isset( $raw['params'] ) ) {
			$params = self::sanitize_params( $raw['params'], $name );
			if ( is_wp_error( $params ) ) {
				return $params;
			}
		}
		$param_names = array_map( 'strval', array_keys( $params ) );

		$motion = array(
			'label' => $label,
			'group' => '' === $group ? 'More' : $group,
			'kind'  => $kind,
		);

		if ( 'entrance' === $kind ) {
			if ( ! isset( $raw['from'] ) || isset( $raw['keyframes'] ) || isset( $raw['legs'] ) || isset( $raw['hold'] ) ) {
				return self::motion_err( $name, __( 'is an entrance, so it needs "from" and may only add "to" and "ease".', 'kwip-animation' ) );
			}
			$from = self::sanitize_props( $raw['from'], $param_names, $name, 'from' );
			if ( is_wp_error( $from ) ) {
				return $from;
			}
			$motion['from'] = $from;

			if ( isset( $raw['to'] ) ) {
				$to = self::sanitize_props( $raw['to'], $param_names, $name, 'to' );
				if ( is_wp_error( $to ) ) {
					return $to;
				}
				$motion['to'] = $to;
			}
		} else {
			if ( isset( $raw['from'] ) || isset( $raw['to'] ) === isset( $raw['keyframes'] ) ) {
				return self::motion_err( $name, __( 'is an effect, so it needs exactly one of "to" or "keyframes".', 'kwip-animation' ) );
			}
			if ( isset( $raw['to'] ) ) {
				$to = self::sanitize_props( $raw['to'], $param_names, $name, 'to' );
				if ( is_wp_error( $to ) ) {
					return $to;
				}
				$motion['to'] = $to;

				if ( isset( $raw['legs'] ) ) {
					if ( ! is_int( $raw['legs'] ) || $raw['legs'] < 2 || $raw['legs'] > 8 ) {
						return self::motion_err( $name, __( 'legs must be a whole number from 2 to 8.', 'kwip-animation' ) );
					}
					$motion['legs'] = $raw['legs'];
				}
				if ( isset( $raw['hold'] ) ) {
					if ( true !== $raw['hold'] || ! isset( $motion['legs'] ) ) {
						return self::motion_err( $name, __( 'hold must be true and needs legs.', 'kwip-animation' ) );
					}
					$motion['hold'] = true;
				}
			} else {
				if ( isset( $raw['legs'] ) || isset( $raw['hold'] ) ) {
					return self::motion_err( $name, __( 'cannot combine keyframes with legs or hold.', 'kwip-animation' ) );
				}
				$keyframes = self::sanitize_props( $raw['keyframes'], $param_names, $name, 'keyframes', true );
				if ( is_wp_error( $keyframes ) ) {
					return $keyframes;
				}
				$motion['keyframes'] = $keyframes;
			}
		}

		if ( isset( $raw['ease'] ) ) {
			if ( ! is_string( $raw['ease'] ) || ! preg_match( self::EASE_PATTERN, $raw['ease'] ) ) {
				return self::motion_err( $name, __( 'uses an ease that is not a standard GSAP ease.', 'kwip-animation' ) );
			}
			$motion['ease'] = $raw['ease'];
		}
		if ( '' !== $glyph ) {
			$motion['glyph'] = $glyph;
		}
		if ( $params ) {
			$motion['params'] = $params;
		}
		return $motion;
	}

	/**
	 * @param mixed    $raw         Properties object.
	 * @param string[] $param_names Declared parameter names usable as "$name" tokens.
	 * @param string   $name        Motion name (for messages).
	 * @param string   $where       "from", "to" or "keyframes" (for messages).
	 * @param bool     $arrays      Keyframe mode: each property maps to a list of values.
	 * @return array|WP_Error
	 */
	private static function sanitize_props( $raw, array $param_names, $name, $where, $arrays = false ) {
		if ( ! is_array( $raw ) || empty( $raw ) || count( $raw ) > self::MAX_PROPS ) {
			return self::motion_err( $name, sprintf( __( '"%s" must be an object with 1 to 8 properties.', 'kwip-animation' ), $where ) );
		}

		$out = array();
		foreach ( $raw as $prop => $value ) {
			$prop = (string) $prop;

			if ( $arrays && 'easeEach' === $prop ) {
				if ( ! is_string( $value ) || ! preg_match( self::EASE_PATTERN, $value ) ) {
					return self::motion_err( $name, __( 'uses an easeEach that is not a standard GSAP ease.', 'kwip-animation' ) );
				}
				$out[ $prop ] = $value;
				continue;
			}
			if ( ! isset( self::NUMERIC_PROPS[ $prop ] ) && ! isset( self::STRING_PROPS[ $prop ] ) ) {
				return self::motion_err( $name, sprintf( __( 'uses the unsupported property "%s".', 'kwip-animation' ), self::short( $prop ) ) );
			}

			if ( $arrays ) {
				if ( ! is_array( $value ) || count( $value ) < 2 || count( $value ) > 16 ) {
					return self::motion_err( $name, sprintf( __( 'keyframes for "%s" need 2 to 16 values.', 'kwip-animation' ), self::short( $prop ) ) );
				}
				$list = array();
				foreach ( $value as $item ) {
					$clean = self::sanitize_value( $prop, $item, $param_names );
					if ( null === $clean ) {
						return self::motion_err( $name, sprintf( __( 'has an invalid value for "%s".', 'kwip-animation' ), self::short( $prop ) ) );
					}
					$list[] = $clean;
				}
				$out[ $prop ] = $list;
			} else {
				$clean = self::sanitize_value( $prop, $value, $param_names );
				if ( null === $clean ) {
					return self::motion_err( $name, sprintf( __( 'has an invalid value for "%s".', 'kwip-animation' ), self::short( $prop ) ) );
				}
				$out[ $prop ] = $clean;
			}
		}
		return $out;
	}

	private static function sanitize_value( $prop, $value, array $param_names ) {
		if ( isset( self::NUMERIC_PROPS[ $prop ] ) ) {
			list( $min, $max ) = self::NUMERIC_PROPS[ $prop ];

			if ( self::is_num( $value ) ) {
				return ( $value >= $min && $value <= $max ) ? $value : null;
			}
			if ( is_string( $value ) ) {
				if ( preg_match( '/^-?\$([a-z][a-z0-9_]{0,23})$/', $value, $m ) ) {
					return in_array( $m[1], $param_names, true ) ? $value : null;
				}
				if ( preg_match( '/^[+-]=(\d{1,5}(?:\.\d{1,4})?)$/', $value, $m ) ) {
					return ( (float) $m[1] <= $max ) ? $value : null;
				}
			}
			return null;
		}

		if ( isset( self::STRING_PROPS[ $prop ] ) && is_string( $value ) && preg_match( self::STRING_PROPS[ $prop ], $value ) ) {
			return $value;
		}
		return null;
	}

	private static function sanitize_params( $raw, $name ) {
		if ( ! is_array( $raw ) || count( $raw ) > self::MAX_PARAMS ) {
			return self::motion_err( $name, __( 'params must be an object with at most 6 entries.', 'kwip-animation' ) );
		}

		$out = array();
		foreach ( $raw as $param => $spec ) {
			$param = (string) $param;
			if ( ! preg_match( '/^[a-z][a-z0-9_]{0,23}$/', $param ) || ! is_array( $spec ) ) {
				return self::motion_err( $name, __( 'has an invalid parameter name.', 'kwip-animation' ) );
			}
			if ( ! isset( $spec['type'] ) || 'number' !== $spec['type'] ) {
				return self::motion_err( $name, __( 'parameters must have type "number".', 'kwip-animation' ) );
			}
			foreach ( array( 'min', 'max', 'default' ) as $key ) {
				if ( ! isset( $spec[ $key ] ) || ! self::is_num( $spec[ $key ] ) || abs( $spec[ $key ] ) > 10000 ) {
					return self::motion_err( $name, sprintf( __( 'parameter "%s" needs numeric min, max and default.', 'kwip-animation' ), self::short( $param ) ) );
				}
			}
			if ( $spec['min'] >= $spec['max'] || $spec['default'] < $spec['min'] || $spec['default'] > $spec['max'] ) {
				return self::motion_err( $name, sprintf( __( 'parameter "%s" must satisfy min < max and min <= default <= max.', 'kwip-animation' ), self::short( $param ) ) );
			}

			$clean = array(
				'type'    => 'number',
				'label'   => self::text( isset( $spec['label'] ) ? $spec['label'] : $param, 30 ),
				'default' => $spec['default'],
				'min'     => $spec['min'],
				'max'     => $spec['max'],
			);
			if ( isset( $spec['step'] ) && self::is_num( $spec['step'] ) && $spec['step'] > 0 && $spec['step'] <= 1000 ) {
				$clean['step'] = $spec['step'];
			}
			if ( isset( $spec['unit'] ) && is_string( $spec['unit'] ) && in_array( $spec['unit'], self::PARAM_UNITS, true ) ) {
				$clean['unit'] = $spec['unit'];
			}
			$out[ $param ] = $clean;
		}
		return $out;
	}


	/**
	 * Flatten a v2 scoped config (or legacy flat map) into a list of
	 * { scope, selector, triggers } entries.
	 *
	 * @param array $config Scoped or flat config.
	 * @return array[]
	 */
	private static function flatten_config( array $config ) {
		$scopes = ( isset( $config['scopes'] ) && is_array( $config['scopes'] ) )
			? $config['scopes']
			: array( 'global' => $config );

		$entries = array();
		foreach ( $scopes as $scope => $selectors ) {
			if ( ! is_array( $selectors ) ) {
				continue;
			}
			foreach ( $selectors as $selector => $triggers ) {
				if ( is_array( $triggers ) ) {
					$entries[] = array(
						'scope'    => (string) $scope,
						'selector' => (string) $selector,
						'triggers' => $triggers,
					);
				}
			}
		}
		return $entries;
	}

	/**
	 * @param array $config Scoped animation config.
	 * @return array { builtin: pack[], installed: pack[] }
	 */
	public static function library( array $config ) {
		self::builtin();

		$used = array();
		foreach ( self::flatten_config( $config ) as $entry ) {
			foreach ( $entry['triggers'] as $settings ) {
				$motion = ( is_array( $settings ) && isset( $settings['animation'] ) ) ? self::get( $settings['animation'] ) : null;
				if ( $motion ) {
					$used[ $motion['pack'] ] = ( isset( $used[ $motion['pack'] ] ) ? $used[ $motion['pack'] ] : 0 ) + 1;
				}
			}
		}

		$summarize = function ( array $pack, $builtin ) use ( $used, $config ) {
			$motions = array();
			foreach ( $pack['motions'] as $name => $motion ) {
				$slug      = $builtin ? $name : $pack['id'] . '/' . $name;
				$motions[] = array(
					'slug'  => $slug,
					'label' => $motion['label'],
					'group' => $motion['group'],
					'kind'  => $motion['kind'],
					'glyph' => self::glyph_of( $slug, $motion ),
				);
			}
			return array(
				'id'          => $pack['id'],
				'name'        => $pack['name'],
				'version'     => $pack['version'],
				'author'      => $pack['author'],
				'description' => $pack['description'],
				'builtin'     => $builtin,
				'used'        => isset( $used[ $pack['id'] ] ) ? $used[ $pack['id'] ] : 0,
				'usages'      => $builtin ? array() : array_slice( self::usages( $pack['id'], $config ), 0, 20 ),
				'motions'     => $motions,
			);
		};

		$out = array(
			'builtin'   => array(),
			'installed' => array(),
		);
		foreach ( self::$builtin_packs as $pack ) {
			$out['builtin'][] = $summarize( $pack, true );
		}
		foreach ( self::installed() as $pack ) {
			if ( is_array( $pack ) && ! empty( $pack['id'] ) && ! empty( $pack['motions'] ) ) {
				$out['installed'][] = $summarize( $pack, false );
			}
		}
		return $out;
	}

	/**
	 * @param string $pack_id Pack id.
	 * @param array  $config  Scoped animation config.
	 * @return array[]
	 */
	public static function usages( $pack_id, array $config ) {
		$found = array();
		foreach ( self::flatten_config( $config ) as $entry ) {
			foreach ( $entry['triggers'] as $trigger => $settings ) {
				if ( ! is_array( $settings ) || empty( $settings['animation'] ) ) {
					continue;
				}
				$slug = (string) $settings['animation'];
				if ( 0 === strpos( $slug, $pack_id . '/' ) ) {
					$found[] = array(
						'scope'     => $entry['scope'],
						'selector'  => $entry['selector'],
						'trigger'   => (string) $trigger,
						'animation' => $slug,
					);
				}
			}
		}
		return $found;
	}

	/**
	 * Remove any trigger using the given pack across all scopes.
	 *
	 * @param string $pack_id Pack id.
	 * @param array  $config  Scoped animation config.
	 * @return array
	 */
	public static function strip_usages( $pack_id, array $config ) {
		$scopes = ( isset( $config['scopes'] ) && is_array( $config['scopes'] ) )
			? $config['scopes']
			: array( 'global' => $config );

		$clean_scopes = array();
		foreach ( $scopes as $scope => $selectors ) {
			if ( ! is_array( $selectors ) ) {
				continue;
			}
			$clean_selectors = array();
			foreach ( $selectors as $selector => $triggers ) {
				if ( ! is_array( $triggers ) ) {
					continue;
				}
				foreach ( $triggers as $trigger => $settings ) {
					$slug = ( is_array( $settings ) && isset( $settings['animation'] ) ) ? (string) $settings['animation'] : '';
					if ( 0 === strpos( $slug, $pack_id . '/' ) ) {
						unset( $triggers[ $trigger ] );
					}
				}
				if ( ! empty( $triggers ) ) {
					$clean_selectors[ $selector ] = $triggers;
				}
			}
			if ( ! empty( $clean_selectors ) ) {
				$clean_scopes[ $scope ] = $clean_selectors;
			}
		}

		return array(
			'version' => KWIPA_Config::SCHEMA_VERSION,
			'scopes'  => $clean_scopes,
		);
	}

	/**
	 * @param array $config Scoped animation config.
	 * @return array[]
	 */
	public static function orphans( array $config ) {
		$found = array();
		foreach ( self::flatten_config( $config ) as $entry ) {
			foreach ( $entry['triggers'] as $trigger => $settings ) {
				if ( is_array( $settings ) && isset( $settings['animation'] ) && null === self::get( $settings['animation'] ) ) {
					$found[] = array(
						'scope'     => $entry['scope'],
						'selector'  => $entry['selector'],
						'trigger'   => (string) $trigger,
						'animation' => (string) $settings['animation'],
					);
				}
			}
		}
		return $found;
	}

	private static function is_num( $value ) {
		return ( is_int( $value ) || is_float( $value ) ) && is_finite( (float) $value );
	}

	private static function text( $value, $max ) {
		$value = is_string( $value ) ? trim( sanitize_text_field( $value ) ) : '';
		return mb_strlen( $value ) > $max ? '' : $value;
	}

	private static function short( $value ) {
		return mb_substr( sanitize_text_field( is_scalar( $value ) ? (string) $value : '' ), 0, 40 );
	}

	private static function err( $message ) {
		return new WP_Error( 'kwipa_invalid_pack', $message, array( 'status' => 400 ) );
	}

	private static function motion_err( $name, $message ) {
		return self::err( sprintf( __( 'Motion "%1$s" %2$s', 'kwip-animation' ), self::short( $name ), $message ) );
	}
}