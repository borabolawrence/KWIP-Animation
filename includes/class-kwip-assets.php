<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}


final class KWIPA_Assets {

	const GSAP_VERSION = '3.13.0';

	/**
	 * Cache-busting version: the file's modification time while WP_DEBUG is on
	 * (so edits show up immediately), the plugin version in production.
	 *
	 * @param string $relative_path Path inside the plugin, e.g. 'assets/js/kwip-engine.js'.
	 * @return string
	 */
	public static function version( $relative_path ) {
		$file = KWIPA_PATH . $relative_path;
		return ( defined( 'WP_DEBUG' ) && WP_DEBUG && is_readable( $file ) ) ? (string) filemtime( $file ) : KWIPA_VERSION;
	}

	/**
	 * @param bool $with_scroll_trigger Make the engine depend on ScrollTrigger.
	 */
	public static function register( $with_scroll_trigger = true ) {
		if ( wp_script_is( 'kwipa-gsap', 'registered' ) ) {
			return;
		}

		wp_register_script( 'kwipa-gsap', KWIPA_URL . 'assets/vendor/gsap.min.js', array(), self::GSAP_VERSION, true );
		wp_register_script( 'kwipa-scrolltrigger', KWIPA_URL . 'assets/vendor/ScrollTrigger.min.js', array( 'kwipa-gsap' ), self::GSAP_VERSION, true );

		$deps = $with_scroll_trigger ? array( 'kwipa-gsap', 'kwipa-scrolltrigger' ) : array( 'kwipa-gsap' );
		wp_register_script( 'kwipa-engine', KWIPA_URL . 'assets/js/kwip-engine.js', $deps, self::version( 'assets/js/kwip-engine.js' ), true );
	}
}