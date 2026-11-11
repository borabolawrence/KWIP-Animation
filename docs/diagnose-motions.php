<?php
// File: kwip-animation/docs/diagnose-motions.php  (TEMPORARY: delete after use)

// Find and load WordPress by walking up from this folder.
$kwipa_dir = __DIR__;
for ( $kwipa_i = 0; $kwipa_i < 8 && ! file_exists( $kwipa_dir . '/wp-load.php' ); $kwipa_i++ ) {
	$kwipa_dir = dirname( $kwipa_dir );
}
if ( ! file_exists( $kwipa_dir . '/wp-load.php' ) ) {
	exit( 'Could not find wp-load.php' );
}
require $kwipa_dir . '/wp-load.php';

// Administrators only, and only while you are logged in to this site in the same browser.
if ( ! is_user_logged_in() || ! current_user_can( 'manage_options' ) ) {
	status_header( 403 );
	exit( 'Log in to wp-admin as an administrator first, then reload this page.' );
}

header( 'Content-Type: text/plain; charset=utf-8' );

if ( ! class_exists( 'KWIPA_Motions' ) ) {
	exit( 'KWIPA_Motions is not loaded: is class-kwip-motions.php required in kwip-animation.php?' );
}

$dir = KWIPA_PATH . 'motions/';
echo 'motions dir: ' . $dir . ( is_dir( $dir ) ? '' : '   <-- MISSING' ) . "\n";
echo 'files in it: ' . ( is_dir( $dir ) ? implode( ', ', scandir( $dir ) ) : '-' ) . "\n";

$file = $dir . 'core.json';
echo 'core.json exists: ' . ( file_exists( $file ) ? 'yes' : 'NO' ) . "\n";

$raw = file_exists( $file ) ? file_get_contents( $file ) : '';
echo 'bytes: ' . strlen( $raw ) . "\n";
echo 'starts with a BOM: ' . ( "\xEF\xBB\xBF" === substr( $raw, 0, 3 ) ? 'YES' : 'no' ) . "\n";

$data = json_decode( $raw, true );
echo 'json_decode: ' . ( null === $data ? json_last_error_msg() : 'ok' ) . "\n";

$pack = KWIPA_Motions::sanitize_pack( $data );
echo 'validation: ' . ( is_wp_error( $pack ) ? $pack->get_error_message() : 'valid, ' . count( $pack['motions'] ) . ' motions' ) . "\n";

echo 'registry count: ' . count( KWIPA_Motions::all() ) . "\n";