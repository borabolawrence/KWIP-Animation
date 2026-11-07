<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Admin side of the builder:
 *  1. The "KWIP Animation" menu page (host for the React app).
 *  2. "Frame mode": a front-end request carrying ?kwipa_builder=1&kwipa_nonce=...
 *     from a logged-in admin gets the inspector bridge + GSAP injected, no admin
 *     bar, and no page caching. Anyone else sees the normal public page.
 */
final class KWIPA_Admin {

	const MENU_SLUG          = 'kwip-animation';
	const FRAME_PARAM        = 'kwipa_builder';
	const FRAME_NONCE_PARAM  = 'kwipa_nonce';
	const FRAME_NONCE_ACTION = 'kwipa_frame';
	const JSON_FLAGS         = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;

	/** @var string|false Hook suffix returned by add_menu_page(). */
	private static $page_hook = false;

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_admin_assets' ) );

		add_action( 'send_headers', array( __CLASS__, 'send_frame_headers' ), 99 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue_frame_assets' ), 100 );
		add_filter( 'show_admin_bar', array( __CLASS__, 'filter_admin_bar' ) );
	}

	/**
	 * True only for a front-end request from an administrator carrying a valid,
	 * action-scoped nonce. The frontend engine (Step 4) must call this and stay
	 * silent when it returns true, because the inspector previews animations itself.
	 *
	 * @return bool
	 */
	public static function is_builder_request() {
		if ( is_admin() || ! isset( $_GET[ self::FRAME_PARAM ], $_GET[ self::FRAME_NONCE_PARAM ] ) ) {
			return false;
		}
		if ( ! is_string( $_GET[ self::FRAME_PARAM ] ) || '1' !== $_GET[ self::FRAME_PARAM ] ) {
			return false;
		}
		if ( ! current_user_can( 'manage_options' ) ) {
			return false;
		}

		$nonce = sanitize_text_field( wp_unslash( $_GET[ self::FRAME_NONCE_PARAM ] ) );

		return (bool) wp_verify_nonce( $nonce, self::FRAME_NONCE_ACTION );
	}

	public static function send_frame_headers() {
		if ( ! self::is_builder_request() ) {
			return;
		}
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		header( 'X-Frame-Options: SAMEORIGIN' );
		header( 'Referrer-Policy: same-origin' );
	}

	/**
	 * The admin bar would shift the page down and be clickable/selectable inside
	 * the iframe, so it is removed in frame mode.
	 *
	 * @param bool $show Whether the admin bar is shown.
	 * @return bool
	 */
	public static function filter_admin_bar( $show ) {
		return self::is_builder_request() ? false : $show;
	}

	public static function enqueue_frame_assets() {
		if ( ! self::is_builder_request() ) {
			return;
		}

		KWIPA_Assets::register( true );

		wp_add_inline_script( 'kwipa-engine', 'window.KWIPABuilderMode = true;', 'before' );

		wp_enqueue_script(
			'kwipa-inspector',
			KWIPA_URL . 'assets/js/kwip-inspector.js',
			array( 'kwipa-engine', 'kwipa-gsap', 'kwipa-scrolltrigger' ),
			KWIPA_VERSION,
			true
		);

		wp_add_inline_script(
			'kwipa-inspector',
			'window.KWIPABridgeConfig = ' . wp_json_encode( array( 'parentOrigin' => self::origin_of( admin_url() ) ), self::JSON_FLAGS ) . ';',
			'before'
		);
	}


	public static function register_menu() {
		self::$page_hook = add_menu_page(
			__( 'KWIP Animation', 'kwip-animation' ),
			__( 'KWIP Animation', 'kwip-animation' ),
			'manage_options',
			self::MENU_SLUG,
			array( __CLASS__, 'render_page' ),
			'dashicons-controls-play',
			58
		);
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'kwip-animation' ), '', array( 'response' => 403 ) );
		}

		echo '<div class="wrap kwipa-wrap"><div id="kwipa-root">';
		echo '<noscript>' . esc_html__( 'KWIP Animation needs JavaScript enabled.', 'kwip-animation' ) . '</noscript>';
		echo '</div></div>';
	}

	public static function enqueue_admin_assets( $hook_suffix ) {
		if ( ! self::$page_hook || $hook_suffix !== self::$page_hook ) {
			return;
		}

		wp_enqueue_style( 'kwipa-admin', KWIPA_URL . 'assets/admin/kwip-admin.css', array(), KWIPA_VERSION );
		wp_enqueue_script( 'kwipa-admin', KWIPA_URL . 'assets/admin/kwip-admin.js', array( 'wp-element' ), KWIPA_VERSION, true );

		wp_add_inline_script(
			'kwipa-admin',
			'window.KWIPAAdminData = ' . wp_json_encode( self::admin_data(), self::JSON_FLAGS ) . ';',
			'before'
		);
	}

	/**
	 * Everything the React app needs at boot, so it makes no initial request.
	 *
	 * @return array
	 */
	private static function admin_data() {
		$home_origin  = self::origin_of( home_url() );
		$admin_origin = self::origin_of( admin_url() );

		return array(
			'rest'       => KWIPA_REST::client_settings(),
			'frame'      => array(
				'url'        => home_url( '/' ),
				'param'      => self::FRAME_PARAM,
				'nonceParam' => self::FRAME_NONCE_PARAM,
				'nonce'      => wp_create_nonce( self::FRAME_NONCE_ACTION ),
				'sameOrigin' => $home_origin === $admin_origin,
			),
			'config'     => KWIPA_Config::as_object( KWIPA_Config::get_config() ),
			'animations' => KWIPA_Config::allowed_animations(),
			'triggers'   => KWIPA_Config::TRIGGERS,
			'limits'     => array(
				'maxDuration' => KWIPA_Config::MAX_DURATION,
				'maxDelay'    => KWIPA_Config::MAX_DELAY,
			),
		);
	}

	private static function origin_of( $url ) {
		$parts = wp_parse_url( $url );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		return $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
	}
}