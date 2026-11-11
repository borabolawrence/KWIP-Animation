<?php

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$kwipa_options = array( 'kwipa_animation_config', 'kwipa_motion_packs' );

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids' ) ) as $kwipa_site_id ) {
		switch_to_blog( $kwipa_site_id );
		foreach ( $kwipa_options as $kwipa_option ) {
			delete_option( $kwipa_option );
		}
		restore_current_blog();
	}
} else {
	foreach ( $kwipa_options as $kwipa_option ) {
		delete_option( $kwipa_option );
	}
}