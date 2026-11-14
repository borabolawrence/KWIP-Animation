<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class KWIPA_Admin {

	const MENU_SLUG          = 'kwip-animation';
	const FRAME_PARAM        = 'kwipa_builder';
	const FRAME_NONCE_PARAM  = 'kwipa_nonce';
	const FRAME_NONCE_ACTION = 'kwipa_frame';
	const JSON_FLAGS         = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
	const LIBRARY_SLUG       = 'kwip-animation-library';

	/** @var array Hook suffix => screen ("builder" or "library"), filled by register_menu(). */
	private static $page_hooks = array();

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_admin_assets' ) );

		add_action( 'send_headers', array( __CLASS__, 'send_frame_headers' ), 99 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue_frame_assets' ), 100 );
		add_filter( 'show_admin_bar', array( __CLASS__, 'filter_admin_bar' ) );
	}

	/**
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

		wp_add_inline_script( 'kwipa-engine', 'window.KWIPABuilderMode = true;window.KWIPAMotions = ' . KWIPA_Config::encode( KWIPA_Motions::client_payload() ) . ';', 'before' );

		wp_enqueue_script(
			'kwipa-inspector',
			KWIPA_URL . 'assets/js/kwip-inspector.js',
			array( 'kwipa-engine', 'kwipa-gsap', 'kwipa-scrolltrigger' ),
			KWIPA_Assets::version( 'assets/js/kwip-inspector.js' ),
			true
		);

		wp_add_inline_script(
			'kwipa-inspector',
			'window.KWIPABridgeConfig = ' . wp_json_encode( array( 'parentOrigin' => self::origin_of( admin_url() ) ), self::JSON_FLAGS ) . ';',
			'before'
		);
	}

	public static function register_menu() {
		$builder = add_menu_page(
			__( 'KWIP Animation', 'kwip-animation' ),
			__( 'KWIP Animation', 'kwip-animation' ),
			'manage_options',
			self::MENU_SLUG,
			array( __CLASS__, 'render_page' ),
			self::menu_icon(),
			58
		);

		add_submenu_page( self::MENU_SLUG, __( 'Builder', 'kwip-animation' ), __( 'Builder', 'kwip-animation' ), 'manage_options', self::MENU_SLUG, array( __CLASS__, 'render_page' ) );
		$library = add_submenu_page( self::MENU_SLUG, __( 'Motion library', 'kwip-animation' ), __( 'Motion library', 'kwip-animation' ), 'manage_options', self::LIBRARY_SLUG, array( __CLASS__, 'render_page' ) );

		self::$page_hooks = array();
		if ( $builder ) {
			self::$page_hooks[ $builder ] = 'builder';
		}
		if ( $library ) {
			self::$page_hooks[ $library ] = 'library';
		}
	}

	private static function menu_icon() {
		$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill="#a7aaad" d="M4 3l10 7-10 7V3z"/><rect fill="#a7aaad" x="15.5" y="3" width="1.8" height="14" rx=".9"/></svg>';
		return 'data:image/svg+xml;base64,' . base64_encode( $svg );
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
		if ( ! isset( self::$page_hooks[ $hook_suffix ] ) ) {
			return;
		}

		$view   = self::$page_hooks[ $hook_suffix ];
		$handle = 'builder' === $view ? 'kwipa-admin' : 'kwipa-library';
		$file   = 'builder' === $view ? 'assets/admin/kwip-admin.js' : 'assets/admin/kwip-library.js';

		wp_enqueue_style( 'kwipa-admin', KWIPA_URL . 'assets/admin/kwip-admin.css', array(), KWIPA_Assets::version( 'assets/admin/kwip-admin.css' ) );
		wp_enqueue_script( $handle, KWIPA_URL . $file, array( 'wp-element' ), KWIPA_Assets::version( $file ), true );

		wp_add_inline_script(
			$handle,
			'window.KWIPAAdminData = ' . wp_json_encode( self::admin_data( $view ), self::JSON_FLAGS ) . ';',
			'before'
		);
	}

	/**
	 * @param string $view "builder" or "library".
	 * @return array
	 */
	private static function admin_data( $view ) {
		$base = array(
			'view' => $view,
			'rest' => KWIPA_REST::client_settings(),
		);

		if ( 'library' === $view ) {
			return $base + array(
				'library'    => KWIPA_Motions::library( KWIPA_Config::get_scoped_config() ),
				'limits'     => array( 'maxPackBytes' => KWIPA_REST::MAX_PACK_BYTES ),
				'builderUrl' => admin_url( 'admin.php?page=' . self::MENU_SLUG ),
			);
		}

		$home_origin  = self::origin_of( home_url() );
		$admin_origin = self::origin_of( admin_url() );

		return $base + array(
			'frame'         => array(
				'url'        => home_url( '/' ),
				'param'      => self::FRAME_PARAM,
				'nonceParam' => self::FRAME_NONCE_PARAM,
				'nonce'      => wp_create_nonce( self::FRAME_NONCE_ACTION ),
				'sameOrigin' => $home_origin === $admin_origin,
			),
			'pages'         => self::site_pages(),
			'config'        => KWIPA_Config::as_scoped_object( KWIPA_Config::get_scoped_config() ),
			'animations'    => KWIPA_Config::allowed_animations(),
			'motions'       => KWIPA_Motions::admin_meta(),
			'triggers'      => KWIPA_Config::TRIGGERS,
			'eases'         => KWIPA_Config::EASES,
			'breakpoints'   => KWIPA_Config::BREAKPOINTS,
			'scrollOptions' => array(
				'starts'        => KWIPA_Config::SCROLL_STARTS,
				'ends'          => KWIPA_Config::SCROLL_ENDS,
				'toggleActions' => KWIPA_Config::TOGGLE_ACTIONS,
			),
			'limits'        => array(
				'maxDuration' => KWIPA_Config::MAX_DURATION,
				'maxDelay'    => KWIPA_Config::MAX_DELAY,
				'maxStagger'  => KWIPA_Config::MAX_STAGGER,
			),
			'libraryUrl'    => admin_url( 'admin.php?page=' . self::LIBRARY_SLUG ),
		);
	}

	/**
	 * @return array[]
	 */
	private static function site_pages() {
		$items = array(
			array(
				'title' => __( 'Home (/)', 'kwip-animation' ),
				'path'  => '/',
			),
		);

		$posts = get_posts(
			array(
				'post_type'      => array( 'page', 'post' ),
				'post_status'    => 'publish',
				'posts_per_page' => 40,
				'orderby'        => 'menu_order title',
				'order'          => 'ASC',
			)
		);

		foreach ( $posts as $post ) {
			$permalink = get_permalink( $post );
			$path      = $permalink ? wp_parse_url( $permalink, PHP_URL_PATH ) : '';
			if ( ! $path || '/' === $path ) {
				continue;
			}
			$items[] = array(
				'title' => $post->post_title ? $post->post_title : $path,
				'path'  => $path,
			);
		}

		return $items;
	}

	private static function origin_of( $url ) {
		$parts = wp_parse_url( $url );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		return $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
	}
}