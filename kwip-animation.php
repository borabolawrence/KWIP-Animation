<?php
/**
 * Plugin Name:       KWIP Animation
 * Description:       Visual point-and-click GSAP animation builder. Theme-agnostic, with zero builder code on the public site.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Lawrence
 * License:           GPL-2.0-or-later
 * Text Domain:       kwip-animation
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'KWIPA_VERSION', '1.0.0' );
define( 'KWIPA_FILE', __FILE__ );
define( 'KWIPA_PATH', plugin_dir_path( __FILE__ ) );
define( 'KWIPA_URL', plugin_dir_url( __FILE__ ) );

require_once KWIPA_PATH . 'includes/class-kwip-config.php';
require_once KWIPA_PATH . 'includes/class-kwip-rest.php';
require_once KWIPA_PATH . 'includes/class-kwip-assets.php';
require_once KWIPA_PATH . 'includes/class-kwip-admin.php';

register_activation_hook( KWIPA_FILE, array( 'KWIPA_Config', 'on_activate' ) );

KWIPA_REST::init();
KWIPA_Admin::init();