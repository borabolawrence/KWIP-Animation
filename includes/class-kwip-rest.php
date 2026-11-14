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
	const MAX_PACK_BYTES = 262144;

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

		register_rest_route(
			self::REST_NAMESPACE,
			'/frame-nonce',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'handle_frame_nonce' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/motions',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'handle_library' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/motions/install',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'handle_install' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/motions/(?P<id>[a-z0-9]+(?:-[a-z0-9]+)*)',
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( __CLASS__, 'handle_remove' ),
				'permission_callback' => array( __CLASS__, 'check_permissions' ),
			)
		);
	}

	public static function handle_library() {
		return rest_ensure_response( array( 'library' => KWIPA_Motions::library( KWIPA_Config::get_config() ) ) );
	}

	public static function handle_frame_nonce() {
		return rest_ensure_response(
			array( 'nonce' => wp_create_nonce( KWIPA_Admin::FRAME_NONCE_ACTION ) )
		);
	}

	public static function handle_install( WP_REST_Request $request ) {
		if ( strlen( (string) $request->get_body() ) > self::MAX_PACK_BYTES ) {
			return new WP_Error(
				'kwipa_payload_too_large',
				__( 'That motion pack is too large to install.', 'kwip-animation' ),
				array( 'status' => 413 )
			);
		}

		$body = $request->get_json_params();
		$raw  = ( is_array( $body ) && isset( $body['pack'] ) ) ? $body['pack'] : null;

		$before = KWIPA_Motions::installed();
		$pack   = KWIPA_Motions::install( $raw );
		if ( is_wp_error( $pack ) ) {
			return $pack;
		}

		$config = KWIPA_Config::get_scoped_config();

		return rest_ensure_response(
			array(
				'success'  => true,
				'name'     => $pack['name'],
				'replaced' => isset( $before[ $pack['id'] ] ),
				'orphans'  => KWIPA_Motions::orphans( $config ),
				'library'  => KWIPA_Motions::library( $config ),
			)
		);
	}

	public static function handle_remove( WP_REST_Request $request ) {
		$id = (string) $request['id'];
		if ( ! isset( KWIPA_Motions::installed()[ $id ] ) ) {
			return new WP_Error( 'kwipa_pack_missing', __( 'That motion pack is not installed.', 'kwip-animation' ), array( 'status' => 404 ) );
		}

		$config = KWIPA_Config::get_scoped_config();
		$usages = KWIPA_Motions::usages( $id, $config );
		$body   = $request->get_json_params();
		$force  = is_array( $body ) && isset( $body['force'] ) && true === $body['force'];

		if ( $usages && ! $force ) {
			return new WP_Error(
				'kwipa_pack_in_use',
				__( 'Animations on this site still use this pack.', 'kwip-animation' ),
				array(
					'status' => 409,
					'count'  => count( $usages ),
					'usages' => array_slice( $usages, 0, 20 ),
				)
			);
		}

		if ( $usages ) {
			$cleaned = KWIPA_Motions::strip_usages( $id, $config );
			if ( ! KWIPA_Config::save( $cleaned ) ) {
				return new WP_Error( 'kwipa_save_failed', __( 'The configuration could not be saved.', 'kwip-animation' ), array( 'status' => 500 ) );
			}
			do_action( 'kwipa_config_saved', $cleaned );
		}

		$removed = KWIPA_Motions::remove( $id );
		if ( is_wp_error( $removed ) ) {
			return $removed;
		}

		return rest_ensure_response(
			array(
				'success'           => true,
				'removedAnimations' => count( $usages ),
				'library'           => KWIPA_Motions::library( KWIPA_Config::get_scoped_config() ),
			)
		);
	}

	public static function handle_get() {
		return rest_ensure_response(
			array( 'config' => KWIPA_Config::as_scoped_object( KWIPA_Config::get_scoped_config() ) )
		);
	}

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

		do_action( 'kwipa_config_saved', $clean );

		return rest_ensure_response(
			array(
				'success' => true,
				'config'  => KWIPA_Config::as_scoped_object( $clean ),
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
}