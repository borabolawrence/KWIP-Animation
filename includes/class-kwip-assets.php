<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}


final class KWIPA_Assets {

	const GSAP_VERSION = '3.13.0';

	public static function register() {
		if ( wp_script_is( 'kwipa-gsap', 'registered' ) ) {
			return;
		}

		wp_register_script( 'kwipa-gsap', KWIPA_URL . 'assets/vendor/gsap.min.js', array(), self::GSAP_VERSION, true );
		wp_register_script( 'kwipa-scrolltrigger', KWIPA_URL . 'assets/vendor/ScrollTrigger.min.js', array( 'kwipa-gsap' ), self::GSAP_VERSION, true );
	}
}