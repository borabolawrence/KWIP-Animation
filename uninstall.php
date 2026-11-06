<?php

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$kwipa_option_key = 'kwipa_animation_config';

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids' ) ) as $kwipa_site_id ) {
		switch_to_blog( $kwipa_site_id );
		delete_option( $kwipa_option_key );
		restore_current_blog();
	}
} else {
	delete_option( $kwipa_option_key );
}