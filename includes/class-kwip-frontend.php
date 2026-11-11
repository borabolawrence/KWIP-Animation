<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Public-site output. When animations exist it loads only:
 *   GSAP core, ScrollTrigger (only if a scroll trigger is configured),
 *   kwip-engine.js, and the config as an inline JSON global.
 * No config means no output at all: zero cost for pages with nothing to animate.
 */
final class KWIPA_Frontend {

	private static $config = null;

	public static function init() {
		add_action( 'wp_head', array( __CLASS__, 'print_prehide' ), 1 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	private static function config() {
		if ( null === self::$config ) {
			self::$config = KWIPA_Config::get_config();
		}
		return self::$config;
	}


	private static function should_run() {
		if ( KWIPA_Admin::is_builder_request() || is_customize_preview() ) {
			return false;
		}
		return ! empty( self::config() );
	}

	/**
	 * Entrance animations would flash: the element paints, then jumps to its
	 * start state. So elements with a load or scroll trigger are hidden from the
	 * first paint, and the engine reveals them once their start state is applied.
	 *
	 * Failsafes, so content can never stay invisible:
	 *  - rules only apply when JS is on (html.kwipa-js is set by the tiny script below);
	 *  - a CSS animation reveals everything after 2s even if the engine never runs;
	 *  - nothing is hidden for visitors who prefer reduced motion;
	 *  - one rule per selector, because one invalid selector would void a whole group.
	 */
	public static function print_prehide() {
		if ( ! self::should_run() ) {
			return;
		}

		$rules = array();
		foreach ( self::config() as $selector => $triggers ) {
			if ( ! is_array( $triggers ) || ( ! isset( $triggers['load'] ) && ! isset( $triggers['scroll'] ) ) ) {
				continue;
			}
			$clean = KWIPA_Config::sanitize_selector( (string) $selector );
			if ( '' === $clean ) {
				continue;
			}
			$rules[] = '.kwipa-js ' . $clean . '{visibility:hidden;animation:kwipa-reveal 0s linear 2s forwards}';
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

		$has_scroll = false;
		$slugs      = array();
		foreach ( self::config() as $triggers ) {
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
			}
		}

		KWIPA_Assets::register( $has_scroll );

		$motions = KWIPA_Motions::client_payload( array_values( array_unique( $slugs ) ) );

		wp_add_inline_script(
			'kwipa-engine',
			'window.KWIPAMotions = ' . KWIPA_Config::encode( $motions ) . ';window.KWIPAnimationConfig = ' . KWIPA_Config::get_config_json() . ';',
			'before'
		);
		wp_enqueue_script( 'kwipa-engine' );
	}
}