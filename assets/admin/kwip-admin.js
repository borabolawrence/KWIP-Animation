/**
 * KWIP Animation - Admin builder.
 * React via WordPress core (wp-element), written without JSX so no build step is needed.
 *
 * Boot data comes from PHP as window.KWIPAAdminData (see KWIPA_Admin::admin_data()).
 * Talks to the preview iframe through postMessage (protocol documented in kwip-inspector.js)
 * and saves through POST {restUrl}/save.
 */
(function () {
    'use strict';

    const data = window.KWIPAAdminData;
    const mount = document.getElementById('kwipa-root');
    const wpEl = window.wp && window.wp.element;

    if (!data || !mount || !wpEl) {
        return;
    }

    const h = wpEl.createElement;
    const { Fragment, useState, useEffect, useRef, useMemo } = wpEl;

    const MSG_FROM_FRAME = 'kwipa-inspector';
    const MSG_TO_FRAME = 'kwipa-builder';
    const MAX_SELECTOR = 255;

    const SELECTOR_OK = /^[\p{L}\p{N}_\-#.>+~:()*\\\/ ]+$/u;

    const TABS = ['load', 'scroll', 'hover', 'click'].filter((t) => data.triggers.indexOf(t) !== -1);
    const TAB_LABELS = { load: 'On load', scroll: 'On scroll', hover: 'On hover', click: 'On click' };
    const TAB_HINTS = {
        load: 'Plays once, as soon as the page has loaded.',
        scroll: 'Plays once, when the element scrolls into view.',
        hover: 'Plays when the pointer moves over the element.',
        click: 'Plays each time the element is clicked.',
    };
    const DEFAULTS = {
        load: { animation: 'fade-up', duration: 1, delay: 0 },
        scroll: { animation: 'fade-in', duration: 1, delay: 0 },
        hover: { animation: 'scale-up', duration: 0.3, delay: 0 },
        click: { animation: 'spin', duration: 0.8, delay: 0 },
    };

    const ANIM_LABELS = {
        'fade-in': 'Fade in', 'fade-up': 'Fade up', 'fade-down': 'Fade down', 'fade-left': 'Fade left', 'fade-right': 'Fade right',
        'scale-up': 'Scale up', 'scale-down': 'Scale down', 'pulse': 'Pulse', 'spin': 'Spin',
        'flip-x': 'Flip X', 'flip-y': 'Flip Y', 'shake': 'Shake',
    };
    const ANIM_GROUPS = [
        { title: 'Entrances', slugs: ['fade-in', 'fade-up', 'fade-down', 'fade-left', 'fade-right'] },
        { title: 'Effects', slugs: ['scale-up', 'scale-down', 'pulse', 'spin', 'flip-x', 'flip-y', 'shake'] },
    ];

    const frameOrigin = new URL(data.frame.url).origin;
    const originOk = frameOrigin === window.location.origin;

    const clamp = (n, min, max) => Math.round(Math.min(Math.max(n, min), max) * 1000) / 1000;
    const fmt = (n) => (Math.round(n * 100) / 100) + ' s';

    function animLabel(slug) {
        if (ANIM_LABELS[slug]) {
            return ANIM_LABELS[slug];
        }
        const text = slug.replace(/-/g, ' ');
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    const GROUPS = (function () {
        const known = {};
        const groups = ANIM_GROUPS.map((g) => {
            g.slugs.forEach((s) => { known[s] = true; });
            return { title: g.title, slugs: g.slugs.filter((s) => data.animations.indexOf(s) !== -1) };
        });
        const extra = data.animations.filter((s) => !known[s]);
        if (extra.length) {
            groups.push({ title: 'More', slugs: extra });
        }
        return groups.filter((g) => g.slugs.length);
    }());

    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {};
        }
        return JSON.parse(JSON.stringify(raw));
    }

    function prepare(config) {
        const out = {};
        Object.keys(config).forEach((selector) => {
            const entry = {};
            TABS.forEach((trigger) => {
                const s = config[selector][trigger];
                if (!s) {
                    return;
                }
                entry[trigger] = {
                    animation: s.animation,
                    duration: Number.isFinite(s.duration) ? s.duration : 1,
                };
                if (s.delay > 0) {
                    entry[trigger].delay = s.delay;
                }
            });
            if (Object.keys(entry).length) {
                out[selector] = entry;
            }
        });
        return out;
    }

    function defaultSettings(trigger) {
        const d = Object.assign({}, DEFAULTS[trigger]);
        if (data.animations.indexOf(d.animation) === -1) {
            d.animation = data.animations[0];
        }
        return d;
    }

    function buildFrameUrl(input) {
        const text = (input || '').trim();
        let url;
        try {
            url = /^https?:\/\//i.test(text) ? new URL(text) : new URL(text.replace(/^\/+/, ''), data.frame.url);
        } catch (e) {
            return null;
        }
        if (url.origin !== frameOrigin) {
            return null;
        }
        url.searchParams.set(data.frame.param, '1');
        url.searchParams.set(data.frame.nonceParam, data.frame.nonce);
        return url.toString();
    }

    function Notice(props) {
        return h('div', { className: 'kwipa-notice is-' + props.type, role: props.type === 'error' ? 'alert' : 'status' },
            h('span', null, props.text),
            h('button', { type: 'button', className: 'kwipa-notice-x', 'aria-label': 'Dismiss', onClick: props.onDismiss }, '\u00d7')
        );
    }

    function NumberField(props) {
        const [text, setText] = useState(String(props.value));
        const inputRef = useRef(null);

        useEffect(() => {
            if (inputRef.current !== document.activeElement) {
                setText(String(props.value));
            }
        }, [props.value]);

        return h('label', { className: 'kwipa-field', htmlFor: props.id },
            h('span', { className: 'kwipa-field-label' }, props.label),
            h('span', { className: 'kwipa-input' },
                h('input', {
                    id: props.id,
                    ref: inputRef,
                    type: 'number',
                    inputMode: 'decimal',
                    min: props.min,
                    max: props.max,
                    step: props.step,
                    value: text,
                    onChange: (e) => {
                        const raw = e.target.value;
                        setText(raw);
                        const n = parseFloat(raw);
                        if (Number.isFinite(n)) {
                            props.onChange(clamp(n, props.min, props.max));
                        }
                    },
                    onBlur: () => setText(String(props.value)),
                }),
                h('em', { 'aria-hidden': 'true' }, 's')
            )
        );
    }

    function PresetGrid(props) {
        const inGroups = GROUPS.some((g) => g.slugs.indexOf(props.value) !== -1);
        const groups = inGroups ? GROUPS : GROUPS.concat([{ title: 'More', slugs: [props.value] }]);

        return h('div', { className: 'kwipa-presets', role: 'radiogroup', 'aria-label': 'Animation' },
            groups.map((group) => h('div', { key: group.title, className: 'kwipa-preset-group' },
                h('p', { className: 'kwipa-group-title' }, group.title),
                h('div', { className: 'kwipa-tiles' },
                    group.slugs.map((slug) => h('button', {
                        key: slug,
                        type: 'button',
                        role: 'radio',
                        'aria-checked': props.value === slug,
                        'data-anim': slug,
                        className: 'kwipa-tile' + (props.value === slug ? ' is-on' : ''),
                        onClick: () => props.onChange(slug),
                    },
                        h('span', { className: 'kwipa-glyph-box', 'aria-hidden': 'true' }, h('i', { className: 'kwipa-glyph' })),
                        h('span', { className: 'kwipa-tile-name' }, animLabel(slug))))
                )
            ))
        );
    }

    function TimingStrip(props) {
        const total = Math.max(2, props.delay + props.duration);
        const wait = (props.delay / total) * 100;
        const run = Math.max(2, (props.duration / total) * 100);

        return h('div', { className: 'kwipa-timing', 'aria-hidden': 'true' },
            h('div', { className: 'kwipa-track' },
                h('span', { className: 'kwipa-wait', style: { width: wait + '%' } }),
                h('span', { className: 'kwipa-run', style: { width: run + '%' } })
            ),
            h('div', { className: 'kwipa-scale' }, h('span', null, '0 s'), h('span', null, fmt(total)))
        );
    }

    function TriggerPanel(props) {
        const s = props.settings;

        return h('div', { className: 'kwipa-panel' + (props.disabled ? ' is-disabled' : ''), role: 'tabpanel' },
            h('p', { className: 'kwipa-hint' }, TAB_HINTS[props.trigger]),
            h('label', { className: 'kwipa-switch' },
                h('input', {
                    type: 'checkbox',
                    role: 'switch',
                    checked: !!s,
                    disabled: props.disabled,
                    onChange: (e) => (e.target.checked ? props.onEnable() : props.onDisable()),
                }),
                h('span', { className: 'kwipa-switch-ui', 'aria-hidden': 'true' }),
                h('span', null, 'Animate ' + TAB_LABELS[props.trigger].toLowerCase())
            ),
            s && h(Fragment, null,
                h('fieldset', { className: 'kwipa-fieldset' },
                    h('legend', null, 'Animation'),
                    h(PresetGrid, { value: s.animation, onChange: (slug) => props.onChange({ animation: slug }) })
                ),
                h('fieldset', { className: 'kwipa-fieldset' },
                    h('legend', null, 'Timing'),
                    h('div', { className: 'kwipa-row' },
                        h(NumberField, { id: 'kwipa-duration', label: 'Duration', value: s.duration, min: 0, max: data.limits.maxDuration, step: 0.1, onChange: (v) => props.onChange({ duration: v }) }),
                        h(NumberField, { id: 'kwipa-delay', label: 'Delay', value: s.delay || 0, min: 0, max: data.limits.maxDelay, step: 0.1, onChange: (v) => props.onChange({ delay: v }) })
                    ),
                    h(TimingStrip, { duration: s.duration, delay: s.delay || 0 })
                ),
                h('div', { className: 'kwipa-actions' },
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-dark', disabled: props.previewDisabled, onClick: props.onPreview }, 'Play preview'),
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', disabled: props.previewDisabled, onClick: props.onReset }, 'Reset'),
                    h('label', { className: 'kwipa-auto' },
                        h('input', { type: 'checkbox', checked: props.autoPreview, onChange: (e) => props.onAutoPreview(e.target.checked) }),
                        h('span', null, 'Preview as I edit')
                    )
                )
            )
        );
    }

    function App() {
        const initial = useMemo(() => normalize(data.config), []);

        const [config, setConfig] = useState(initial);
        const [saved, setSaved] = useState(initial);
        const [selected, setSelected] = useState('');
        const [selectedLabel, setSelectedLabel] = useState('');
        const [tab, setTab] = useState(TABS[0]);
        const [pageInput, setPageInput] = useState('/');
        const [frameSrc, setFrameSrc] = useState(() => (originOk ? buildFrameUrl('/') : null));
        const [frameKey, setFrameKey] = useState(0);
        const [bridge, setBridge] = useState({ state: 'loading', gsap: false, scrollTrigger: false });
        const [notice, setNotice] = useState(null);
        const [autoPreview, setAutoPreview] = useState(true);
        const [saving, setSaving] = useState(false);

        const iframeRef = useRef(null);
        const selectedRef = useRef('');
        const previewTimer = useRef(0);
        const watchdog = useRef(0);
        const saveRef = useRef(null);
        selectedRef.current = selected;

        const dirty = useMemo(() => JSON.stringify(prepare(config)) !== JSON.stringify(prepare(saved)), [config, saved]);

        function send(type, extra) {
            const win = iframeRef.current && iframeRef.current.contentWindow;
            if (win) {
                win.postMessage(Object.assign({ source: MSG_TO_FRAME, type }, extra), frameOrigin);
            }
        }

        useEffect(() => {
            function onMessage(e) {
                const frameWin = iframeRef.current && iframeRef.current.contentWindow;
                if (!frameWin || e.source !== frameWin || e.origin !== frameOrigin) {
                    return;
                }
                const msg = e.data;
                if (!msg || typeof msg !== 'object' || msg.source !== MSG_FROM_FRAME || typeof msg.type !== 'string') {
                    return;
                }

                if (msg.type === 'ready') {
                    clearTimeout(watchdog.current);
                    setBridge({ state: 'ready', gsap: !!msg.gsap, scrollTrigger: !!msg.scrollTrigger });
                    if (selectedRef.current) {
                        send('highlight', { selector: selectedRef.current });
                    }
                } else if (msg.type === 'select') {
                    if (typeof msg.selector === 'string' && msg.selector.length <= MAX_SELECTOR && SELECTOR_OK.test(msg.selector)) {
                        setSelected(msg.selector);
                        setSelectedLabel(typeof msg.label === 'string' ? msg.label.slice(0, 120) : '');
                    }
                } else if (msg.type === 'error') {
                    setNotice({ type: 'error', text: typeof msg.message === 'string' ? msg.message.slice(0, 200) : 'The preview frame reported an error.' });
                }
            }

            window.addEventListener('message', onMessage);
            return () => window.removeEventListener('message', onMessage);
        }, []);

        function onFrameLoad() {
            send('ping');
            clearTimeout(watchdog.current);
            watchdog.current = setTimeout(() => {
                setBridge((b) => (b.state === 'ready' ? b : Object.assign({}, b, { state: 'silent' })));
            }, 4000);
        }

        function navigate(e) {
            e.preventDefault();
            const url = buildFrameUrl(pageInput);
            if (!url) {
                setNotice({ type: 'error', text: 'Enter a page on this site, for example / or /about/.' });
                return;
            }
            setNotice(null);
            setBridge({ state: 'loading', gsap: false, scrollTrigger: false });
            setFrameSrc(url);
            setFrameKey((k) => k + 1);
        }


        function applyTrigger(selector, trigger, value) {
            setConfig((prev) => {
                const next = Object.assign({}, prev);
                const triggers = Object.assign({}, next[selector]);
                if (value) {
                    triggers[trigger] = value;
                } else {
                    delete triggers[trigger];
                }
                if (Object.keys(triggers).length) {
                    next[selector] = triggers;
                } else {
                    delete next[selector];
                }
                return next;
            });
        }

        function previewNow(selector, trigger, s) {
            send('preview', { selector, trigger, settings: { animation: s.animation, duration: s.duration, delay: s.delay || 0 } });
        }

        function schedulePreview(selector, trigger, s) {
            if (!autoPreview) {
                return;
            }
            clearTimeout(previewTimer.current);
            previewTimer.current = setTimeout(() => previewNow(selector, trigger, s), 350);
        }

        const current = selected && config[selected] ? config[selected][tab] || null : null;

        function enableTrigger() {
            const s = defaultSettings(tab);
            applyTrigger(selected, tab, s);
            schedulePreview(selected, tab, s);
        }

        function disableTrigger() {
            applyTrigger(selected, tab, null);
            clearTimeout(previewTimer.current);
            send('clear', { selector: selected });
        }

        function changeTrigger(patch) {
            const s = Object.assign({}, current, patch);
            applyTrigger(selected, tab, s);
            schedulePreview(selected, tab, s);
        }

        function pick(selector) {
            setSelected(selector);
            setSelectedLabel('');
            send('highlight', { selector });
        }

        function removeElement(selector) {
            setConfig((prev) => {
                const next = Object.assign({}, prev);
                delete next[selector];
                return next;
            });
            send('clear', { selector });
        }

        function discard() {
            setConfig(saved);
            send('clear');
            setNotice({ type: 'info', text: 'Changes discarded.' });
        }


        async function save() {
            if (saving || !dirty) {
                return;
            }
            setSaving(true);
            setNotice(null);
            try {
                const res = await fetch(data.rest.restUrl.replace(/\/$/, '') + '/save', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-WP-Nonce': data.rest.restNonce,
                        'X-KWIPA-Nonce': data.rest.kwipNonce,
                    },
                    body: JSON.stringify({ config: prepare(config) }),
                });

                let body = null;
                try {
                    body = await res.json();
                } catch (e) {
                    body = null;
                }

                if (!res.ok) {
                    const expired = body && (body.code === 'kwipa_bad_nonce' || body.code === 'rest_cookie_invalid_nonce');
                    throw new Error(expired
                        ? 'Your security token expired. Reload this page to continue; unsaved changes will be lost.'
                        : ((body && body.message) || 'Save failed (HTTP ' + res.status + ').'));
                }

                const next = normalize(body && body.config);
                setConfig(next);
                setSaved(next);
                setNotice({ type: 'success', text: 'Changes saved.' });
            } catch (err) {
                setNotice({ type: 'error', text: err && err.message ? err.message : 'Save failed.' });
            } finally {
                setSaving(false);
            }
        }
        saveRef.current = save;

        useEffect(() => {
            function onKey(e) {
                if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
                    e.preventDefault();
                    saveRef.current();
                }
            }
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }, []);

        useEffect(() => {
            if (!dirty) {
                return undefined;
            }
            const onBeforeUnload = (e) => {
                e.preventDefault();
                e.returnValue = '';
            };
            window.addEventListener('beforeunload', onBeforeUnload);
            return () => window.removeEventListener('beforeunload', onBeforeUnload);
        }, [dirty]);

        useEffect(() => {
            if (!notice || notice.type !== 'success') {
                return undefined;
            }
            const t = setTimeout(() => setNotice(null), 2500);
            return () => clearTimeout(t);
        }, [notice]);

        useEffect(() => () => {
            clearTimeout(previewTimer.current);
            clearTimeout(watchdog.current);
        }, []);


        const statusText = {
            loading: 'Loading page\u2026',
            ready: bridge.gsap ? 'Ready. Click an element to select it.' : 'Ready, but GSAP did not load in the preview.',
            silent: 'Preview not responding. Check page caching and framing rules.',
        }[bridge.state];

        const elementKeys = Object.keys(config);

        return h('div', { className: 'kwipa-app' },
            h('aside', { className: 'kwipa-sidebar' },
                h('header', { className: 'kwipa-head' },
                    h('div', { className: 'kwipa-brand' },
                        h('h1', null, 'KWIP Animation'),
                        h('span', { className: 'kwipa-state' + (dirty ? ' is-dirty' : '') }, h('i', { 'aria-hidden': 'true' }), dirty ? 'Unsaved changes' : 'Saved')
                    ),
                    h('div', { className: 'kwipa-head-actions' },
                        h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', disabled: !dirty || saving, onClick: discard }, 'Discard'),
                        h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-primary', disabled: !dirty || saving, onClick: save }, saving ? 'Saving\u2026' : 'Save changes')
                    )
                ),

                h('div', { className: 'kwipa-scroll' },
                    notice && h(Notice, { type: notice.type, text: notice.text, onDismiss: () => setNotice(null) }),

                    h('section', { className: 'kwipa-section' },
                        h('h2', null, 'Selected element'),
                        selected
                            ? h(Fragment, null,
                                h('code', { className: 'kwipa-selector' }, selected),
                                selectedLabel && h('p', { className: 'kwipa-label' }, selectedLabel))
                            : h(Fragment, null,
                                h('p', { className: 'kwipa-empty' }, 'Click anything on the page to animate it.'),
                                h('p', { className: 'kwipa-hint' }, 'Links and buttons are paused while you build.'))
                    ),

                    h('section', { className: 'kwipa-section' },
                        h('div', { className: 'kwipa-tabs', role: 'tablist' },
                            TABS.map((t) => h('button', {
                                key: t,
                                type: 'button',
                                role: 'tab',
                                'aria-selected': tab === t,
                                className: 'kwipa-tab' + (tab === t ? ' is-active' : ''),
                                onClick: () => setTab(t),
                            }, TAB_LABELS[t], selected && config[selected] && config[selected][t] ? h('i', { className: 'kwipa-dot', 'aria-label': 'enabled' }) : null))
                        ),
                        h(TriggerPanel, {
                            trigger: tab,
                            settings: current,
                            disabled: !selected,
                            previewDisabled: bridge.state !== 'ready',
                            autoPreview,
                            onAutoPreview: setAutoPreview,
                            onEnable: enableTrigger,
                            onDisable: disableTrigger,
                            onChange: changeTrigger,
                            onPreview: () => current && previewNow(selected, tab, current),
                            onReset: () => send('clear', { selector: selected }),
                        })
                    ),

                    h('section', { className: 'kwipa-section' },
                        h('h2', null, 'Animated elements', h('span', { className: 'kwipa-count' }, elementKeys.length)),
                        elementKeys.length
                            ? h('ul', { className: 'kwipa-list' }, elementKeys.map((selector) => h('li', { key: selector, className: 'kwipa-item' + (selector === selected ? ' is-active' : '') },
                                h('button', { type: 'button', className: 'kwipa-item-main', onClick: () => pick(selector) },
                                    h('code', { title: selector }, selector),
                                    h('span', { className: 'kwipa-badges' }, TABS.filter((t) => config[selector][t]).map((t) => h('span', { key: t, className: 'kwipa-badge' }, t)))
                                ),
                                h('button', { type: 'button', className: 'kwipa-item-del', 'aria-label': 'Remove all animations from ' + selector, onClick: () => removeElement(selector) }, '\u00d7')
                            )))
                            : h('p', { className: 'kwipa-hint' }, 'Nothing yet. Select an element, pick a trigger, then choose an animation.')
                    )
                )
            ),

            h('main', { className: 'kwipa-stage' },
                h('form', { className: 'kwipa-bar', onSubmit: navigate },
                    h('label', { className: 'kwipa-bar-label', htmlFor: 'kwipa-page' }, 'Preview page'),
                    h('input', { id: 'kwipa-page', type: 'text', value: pageInput, placeholder: '/ or /about/', disabled: !originOk, onChange: (e) => setPageInput(e.target.value) }),
                    h('button', { type: 'submit', className: 'kwipa-btn kwipa-btn-dark', disabled: !originOk }, 'Go'),
                    h('span', { className: 'kwipa-status is-' + bridge.state }, h('i', { 'aria-hidden': 'true' }), statusText)
                ),
                !originOk
                    ? h('div', { className: 'kwipa-blocked' },
                        h('h2', null, 'Preview unavailable'),
                        h('p', null, 'This admin page is open on ' + window.location.origin + ', but the site lives on ' + frameOrigin + '. The builder only talks to a preview on the same origin.'),
                        h('p', null, 'Open wp-admin from the site address, or make the WordPress Address and Site Address use the same domain.'))
                    : frameSrc
                        ? h('iframe', {
                            key: frameKey,
                            ref: iframeRef,
                            className: 'kwipa-frame',
                            src: frameSrc,
                            title: 'Site preview',
                            sandbox: 'allow-scripts allow-same-origin',
                            referrerPolicy: 'same-origin',
                            onLoad: onFrameLoad,
                        })
                        : null
            )
        );
    }

    if (wpEl.createRoot) {
        wpEl.createRoot(mount).render(h(App));
    } else {
        wpEl.render(h(App), mount);
    }
}());