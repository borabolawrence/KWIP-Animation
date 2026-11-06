<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * REST routes:
 *   GET  /wp-json/kwip-animation/v1/config  -> current config
 *   POST /wp-json/kwip-animation/v1/save    -> validate, sanitize, store { "config": {...} }
 *
 * Every route passes through check_permissions(): capability first, then nonce.
 */
final class KWIPA_REST {

	const REST_NAMESPACE    = 'kwip-animation/v1';
	const NONCE_ACTION      = 'kwipa_builder';
	const NONCE_HEADER      = 'X-KWIPA-Nonce';
	const MAX_PAYLOAD_BYTES = 524288;

	/**
	 * Hook registration only.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/config',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'handle_get' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/save',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'handle_save' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);
	}

	/**
	 * Values the admin React app (Step 3) needs to talk to this API.
	 * 'restNonce' satisfies core's cookie auth (X-WP-Nonce); 'kwipNonce' is our
	 * own action-scoped nonce sent in X-KWIPA-Nonce.
	 *
	 * @return array
	 */
	public static function client_settings() {
		return array(
			'restUrl'   => esc_url_raw( rest_url( self::REST_NAMESPACE ) ),
			'restNonce' => wp_create_nonce( 'wp_rest' ),
			'kwipNonce' => wp_create_nonce( self::NONCE_ACTION ),
		);
	}

	/**
	 * Gate for every endpoint: capability, then plugin-specific nonce.
	 *
	 * @param WP_REST_Request $request Incoming request.
	 * @return true|WP_Error
	 */
	public static function check_permissions( WP_REST_Request $request ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			return new WP_Error(
				'kwipa_forbidden',
				__( 'You do not have permission to manage KWIP Animation.', 'kwip-animation' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}

		$nonce = $request->get_header( self::NONCE_HEADER );
		if ( ! is_string( $nonce ) || ! wp_verify_nonce( $nonce, self::NONCE_ACTION ) ) {
			return new WP_Error(
				'kwipa_bad_nonce',
				__( 'Security check failed. Reload the builder and try again.', 'kwip-animation' ),
				array( 'status' => 403 )
			);
		}

		return true;
	}

	public static function handle_get() {
		return rest_ensure_response(
			array( 'config' => KWIPA_Config::as_object( KWIPA_Config::get_config() ) )
		);
	}

	/**
	 * POST /save
	 *
	 * @param WP_REST_Request $request Incoming request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function handle_save( WP_REST_Request $request ) {
		if ( strlen( (string) $request->get_body() ) > self::MAX_PAYLOAD_BYTES ) {
			return new WP_Error(
				'kwipa_payload_too_large',
				__( 'The configuration is too large to save.', 'kwip-animation' ),
				array( 'status' => 413 )
			);
		}

		$body = $request->get_json_params();
		$raw  = ( is_array( $body ) && isset( $body['config'] ) ) ? $body['config'] : null;

		$clean = KWIPA_Config::sanitize( $raw );
		if ( is_wp_error( $clean ) ) {
			return $clean;
		}

		if ( ! KWIPA_Config::save( $clean ) ) {
			return new WP_Error(
				'kwipa_save_failed',
				__( 'The configuration could not be saved.', 'kwip-animation' ),
				array( 'status' => 500 )
			);
		}

		/**
		 * Fires after a successful save. Hook here to purge page caches, since the
		 * config is inlined into the HTML of cached pages.
		 *
		 * @param array $clean The sanitized config that was stored.
		 */
		do_action( 'kwipa_config_saved', $clean );

		return rest_ensure_response(
			array(
				'success' => true,
				'config'  => KWIPA_Config::as_object( $clean ),
			)
		);
	}
}