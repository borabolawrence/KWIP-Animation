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
    const MAX_HISTORY = 40;
    const MAX_STEPS = (data.limits && data.limits.maxSteps) || 8;
    const ATTR_TOKEN = /^\[[a-zA-Z][a-zA-Z0-9_-]*(?:[~|^$*]?="[a-zA-Z0-9 _.:-]{1,64}")?\]$/;
    const BASE_SELECTOR_OK = /^[\p{L}\p{N}_\-#.>+~:()*\\\/ ]+$/u;
    const POS_OK = /^(>|<|[+-]=\d{1,2}(\.\d{1,2})?)$/;

    const TABS = ['load', 'scroll', 'hover', 'click'].filter((t) => data.triggers.indexOf(t) !== -1);
    const TAB_LABELS = { load: 'Load', scroll: 'Scroll', hover: 'Hover', click: 'Click' };
    const TAB_HINTS = {
        load: 'Plays automatically when the page finishes loading.',
        scroll: 'Triggers on viewport entry or scrubs with scroll progress.',
        hover: 'Plays when the pointer enters the target element.',
        click: 'Plays each time the target element is clicked.',
    };
    const DEFAULTS = {
        load: { animation: 'fade-up', duration: 1, delay: 0, stagger: 0, ease: '', breakpoint: 'all' },
        scroll: {
            animation: 'fade-in',
            duration: 1,
            delay: 0,
            stagger: 0,
            ease: '',
            breakpoint: 'all',
            scroll: { start: 'top 85%', end: 'bottom 20%', scrub: false, pin: false, toggleActions: 'play none none none', trigger: '' },
        },
        hover: { animation: 'scale-up', duration: 0.3, delay: 0, stagger: 0, ease: '', breakpoint: 'all' },
        click: { animation: 'spin', duration: 0.8, delay: 0, stagger: 0, ease: '', breakpoint: 'all' },
    };

    const POSITION_PILLS = [
        { value: '>', label: 'Next (after prev)' },
        { value: '<', label: 'With prev' },
        { value: '-=0.15', label: 'Overlap 0.15s' },
        { value: '-=0.3', label: 'Overlap 0.30s' },
        { value: '+=0.2', label: 'Pause 0.20s' },
        { value: '+=0.5', label: 'Pause 0.50s' },
    ];

    const EASE_CURVES = {
        '': 'M 2 38 C 12 38, 18 4, 52 4',
        'power2.out': 'M 2 38 C 14 38, 22 4, 52 4',
        'power3.out': 'M 2 38 C 10 38, 16 4, 52 4',
        'power4.out': 'M 2 38 C 6 38, 10 4, 52 4',
        'power2.inOut': 'M 2 38 C 24 38, 28 4, 52 4',
        'expo.out': 'M 2 38 C 5 38, 8 4, 52 4',
        'circ.out': 'M 2 38 C 8 36, 18 4, 52 4',
        'back.out(1.7)': 'M 2 38 C 14 38, 26 -6, 38 2 C 44 5, 48 4, 52 4',
        'elastic.out(1,0.3)': 'M 2 38 C 10 38, 14 -6, 20 8 C 25 0, 30 6, 36 3 C 42 5, 47 4, 52 4',
        'bounce.out': 'M 2 38 Q 14 4 22 4 Q 28 20 34 4 Q 39 11 44 4 Q 48 6 52 4',
        'sine.inOut': 'M 2 38 C 20 38, 34 4, 52 4',
        'none': 'M 2 38 L 52 4',
    };

    const frameOrigin = new URL(data.frame.url).origin;
    const originOk = frameOrigin === window.location.origin;

    const clamp = (n, min, max) => Math.round(Math.min(Math.max(n, min), max) * 1000) / 1000;
    const fmt = (n) => (Math.round(n * 100) / 100) + 's';
    const clone = (obj) => JSON.parse(JSON.stringify(obj));

    const MOTIONS = data.motions || {};
    const EASES = data.eases || { '': 'Preset default' };
    const BREAKPOINTS = data.breakpoints || { all: 'All devices' };
    const SCROLL_OPTS = data.scrollOptions || { starts: {}, ends: {}, toggleActions: {} };

    function normalizePath(input) {
        let p = (input || '/').trim();
        try {
            if (/^https?:\/\//i.test(p)) {
                p = new URL(p).pathname;
            }
        } catch (e) {
            p = '/';
        }
        p = p.split('?')[0].split('#')[0];
        p = '/' + p.replace(/^\/+|\/+$/g, '');
        return p === '/' ? '/' : p + '/';
    }

    function isSelectorValid(selector) {
        if (typeof selector !== 'string' || !selector.trim() || selector.length > MAX_SELECTOR || selector.indexOf('</') !== -1) {
            return false;
        }
        let invalidAttr = false;
        const stripped = selector.trim().replace(/\[[^\]]*\]/g, (token) => {
            if (!ATTR_TOKEN.test(token)) {
                invalidAttr = true;
            }
            return '__ATTR__';
        });
        if (invalidAttr || stripped.indexOf('[') !== -1 || stripped.indexOf(']') !== -1 || /[>+~\\]$/.test(stripped)) {
            return false;
        }
        return BASE_SELECTOR_OK.test(stripped);
    }

    function animLabel(slug) {
        return MOTIONS[slug] && MOTIONS[slug].label ? MOTIONS[slug].label : slug;
    }

    function describeFlow(idx, pos, delay) {
        if (idx === 0) {
            return delay > 0 ? 'Starts after ' + fmt(delay) : 'Starts first';
        }
        const prevNum = '0' + idx;
        if (pos === '<') {
            return 'With ' + prevNum;
        }
        if (pos && pos.indexOf('-=') === 0) {
            return 'Overlaps ' + prevNum + ' (' + pos.slice(2) + 's)';
        }
        if (pos && pos.indexOf('+=') === 0) {
            return 'Waits +' + pos.slice(2) + 's after ' + prevNum;
        }
        return 'Next after ' + prevNum;
    }

    const GROUPS = (function () {
        const order = [];
        const byTitle = {};
        data.animations.forEach((slug) => {
            const title = (MOTIONS[slug] && MOTIONS[slug].group) || 'More';
            if (!byTitle[title]) {
                byTitle[title] = { title, slugs: [] };
                order.push(title);
            }
            byTitle[title].slugs.push(slug);
        });
        return order.map((title) => byTitle[title]);
    }());

    function normalizeScoped(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { version: 2, scopes: {} };
        }
        if (raw.scopes && typeof raw.scopes === 'object' && !Array.isArray(raw.scopes)) {
            return { version: 2, scopes: clone(raw.scopes) };
        }
        return { version: 2, scopes: Object.keys(raw).length ? { global: clone(raw) } : {} };
    }

    function sanitizeParamsForMotion(slug, rawParams) {
        const specMap = MOTIONS[slug] && MOTIONS[slug].params;
        if (!specMap || typeof specMap !== 'object' || !rawParams || typeof rawParams !== 'object') {
            return undefined;
        }
        const out = {};
        Object.keys(specMap).forEach((key) => {
            const spec = specMap[key];
            const val = Number(rawParams[key]);
            if (Number.isFinite(val)) {
                out[key] = clamp(val, spec.min, spec.max);
            }
        });
        return Object.keys(out).length ? out : undefined;
    }

    function prepareScroll(rawScroll) {
        if (!rawScroll || typeof rawScroll !== 'object') {
            return undefined;
        }
        const out = {};
        if (rawScroll.start && rawScroll.start !== 'top 85%') {
            out.start = rawScroll.start;
        }
        if (rawScroll.end && rawScroll.end !== 'bottom 20%') {
            out.end = rawScroll.end;
        }
        if (rawScroll.scrub === true || (typeof rawScroll.scrub === 'number' && rawScroll.scrub > 0)) {
            out.scrub = rawScroll.scrub;
        }
        if (rawScroll.pin === true) {
            out.pin = true;
        }
        if (rawScroll.toggleActions && rawScroll.toggleActions !== 'play none none none') {
            out.toggleActions = rawScroll.toggleActions;
        }
        if (typeof rawScroll.trigger === 'string' && rawScroll.trigger.trim()) {
            out.trigger = rawScroll.trigger.trim();
        }
        return Object.keys(out).length ? out : undefined;
    }

    function prepareSteps(rawSteps) {
        if (!Array.isArray(rawSteps) || !rawSteps.length) {
            return undefined;
        }
        const out = [];
        rawSteps.slice(0, MAX_STEPS).forEach((st) => {
            if (!st || typeof st !== 'object' || typeof st.animation !== 'string' || !st.animation) {
                return;
            }
            const item = {
                animation: st.animation,
                duration: Number.isFinite(st.duration) ? st.duration : 0.6,
            };
            if (typeof st.target === 'string' && st.target.trim() && isSelectorValid(st.target.trim())) {
                item.target = st.target.trim();
            }
            if (typeof st.position === 'string' && st.position && st.position !== '>' && POS_OK.test(st.position)) {
                item.position = st.position;
            }
            if (typeof st.ease === 'string' && st.ease) {
                item.ease = st.ease;
            }
            const params = sanitizeParamsForMotion(st.animation, st.params);
            if (params) {
                item.params = params;
            }
            out.push(item);
        });
        return out.length ? out : undefined;
    }

    function prepareScoped(scopedDoc) {
        const cleanScopes = {};
        const scopes = (scopedDoc && scopedDoc.scopes) || {};

        Object.keys(scopes).forEach((scopeKey) => {
            const rules = scopes[scopeKey];
            if (!rules || typeof rules !== 'object') {
                return;
            }
            const outRules = {};
            Object.keys(rules).forEach((selector) => {
                if (!isSelectorValid(selector)) {
                    return;
                }
                const entry = {};
                TABS.forEach((trigger) => {
                    const s = rules[selector][trigger];
                    if (!s || typeof s.animation !== 'string') {
                        return;
                    }
                    const item = {
                        animation: s.animation,
                        duration: Number.isFinite(s.duration) ? s.duration : 1,
                    };
                    if (s.delay > 0) {
                        item.delay = s.delay;
                    }
                    if (s.stagger > 0) {
                        item.stagger = s.stagger;
                    }
                    if (typeof s.ease === 'string' && s.ease) {
                        item.ease = s.ease;
                    }
                    if (typeof s.breakpoint === 'string' && s.breakpoint && s.breakpoint !== 'all') {
                        item.breakpoint = s.breakpoint;
                    }
                    const params = sanitizeParamsForMotion(s.animation, s.params);
                    if (params) {
                        item.params = params;
                    }
                    if (trigger === 'scroll') {
                        const sc = prepareScroll(s.scroll);
                        if (sc) {
                            item.scroll = sc;
                        }
                    }
                    const steps = prepareSteps(s.steps);
                    if (steps) {
                        item.steps = steps;
                    }
                    entry[trigger] = item;
                });
                if (Object.keys(entry).length) {
                    outRules[selector] = entry;
                }
            });
            if (Object.keys(outRules).length) {
                cleanScopes[scopeKey] = outRules;
            }
        });

        return { version: 2, scopes: cleanScopes };
    }

    function defaultSettings(trigger) {
        const d = clone(DEFAULTS[trigger]);
        if (data.animations.indexOf(d.animation) === -1) {
            d.animation = data.animations[0];
        }
        return d;
    }

    function buildFrameUrl(input, nonce) {
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
        url.searchParams.set(data.frame.nonceParam, nonce || data.frame.nonce);
        return url.toString();
    }

    function toUnifiedSteps(s) {
        const first = {
            animation: s.animation,
            duration: Number.isFinite(s.duration) ? s.duration : 1,
            ease: s.ease || '',
            params: s.params ? clone(s.params) : undefined,
            position: '0',
            target: '',
        };
        const rest = Array.isArray(s.steps)
            ? s.steps.map((st) => ({
                animation: st.animation,
                duration: Number.isFinite(st.duration) ? st.duration : 0.6,
                ease: st.ease || '',
                params: st.params ? clone(st.params) : undefined,
                position: st.position || '>',
                target: st.target || '',
            }))
            : [];
        return [first].concat(rest);
    }

    function fromUnifiedSteps(list) {
        const first = list[0];
        const rest = list.slice(1).map((st) => ({
            animation: st.animation,
            duration: st.duration,
            position: st.position || '>',
            ease: st.ease || '',
            params: st.params,
            target: st.target || undefined,
        }));
        return {
            animation: first.animation,
            duration: first.duration,
            ease: first.ease || '',
            params: first.params,
            steps: rest.length ? rest : undefined,
        };
    }

    function computeTimelineLayout(steps, delay, stagger) {
        const d0 = Number(delay) || 0;
        let prevStart = d0;
        let prevEnd = d0;
        let maxEnd = d0;

        const bars = steps.map((st, idx) => {
            const dur = Math.max(0, Number(st.duration) || 0);
            let start = d0;
            if (idx > 0) {
                const pos = st.position || '>';
                if (pos === '<') {
                    start = prevStart;
                } else if (pos.indexOf('-=') === 0) {
                    start = Math.max(0, prevEnd - (parseFloat(pos.slice(2)) || 0));
                } else if (pos.indexOf('+=') === 0) {
                    start = prevEnd + (parseFloat(pos.slice(2)) || 0);
                } else {
                    start = prevEnd;
                }
            }
            const end = start + dur;
            prevStart = start;
            prevEnd = end;
            if (end > maxEnd) {
                maxEnd = end;
            }
            return { index: idx, step: st, start, end, duration: dur };
        });

        const total = Math.max(1.2, maxEnd + (Number(stagger) || 0));
        return { bars, total, activeEnd: maxEnd, delay: d0 };
    }

    function StudioLogo() {
        return h('span', { className: 'kwipa-logo', 'aria-hidden': 'true' },
            h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'currentColor' },
                h('path', { d: 'M4 3l10 7-10 7V3z' }),
                h('rect', { x: 15.2, y: 3, width: 2, height: 14, rx: 1 })
            )
        );
    }

    function Notice(props) {
        return h('div', { className: 'kwipa-notice is-' + props.type, role: props.type === 'error' ? 'alert' : 'status' },
            h('span', null, props.text),
            h('button', { type: 'button', className: 'kwipa-notice-x', 'aria-label': 'Dismiss', onClick: props.onDismiss }, '\u00d7')
        );
    }

    function SliderNumberField(props) {
        const [text, setText] = useState(String(props.value));
        const inputRef = useRef(null);

        useEffect(() => {
            if (inputRef.current !== document.activeElement) {
                setText(String(props.value));
            }
        }, [props.value]);

        return h('div', { className: 'kwipa-field' },
            h('div', { className: 'kwipa-field-head' },
                h('label', { className: 'kwipa-field-label', htmlFor: props.id }, props.label)
            ),
            h('div', { className: 'kwipa-slider-row' },
                h('input', {
                    type: 'range',
                    className: 'kwipa-range',
                    'aria-label': props.label + ' slider',
                    min: props.min,
                    max: props.max,
                    step: props.step,
                    value: props.value,
                    onChange: (e) => props.onChange(clamp(parseFloat(e.target.value), props.min, props.max)),
                }),
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
                    props.unit !== '' && h('em', { 'aria-hidden': 'true' }, props.unit || 's')
                )
            )
        );
    }

    function CompactNumberField(props) {
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

    function EaseCurvePreview(props) {
        const d = EASE_CURVES[props.ease || ''] || EASE_CURVES[''];
        return h('svg', { className: 'kwipa-curve-svg', viewBox: '0 0 54 42', 'aria-hidden': 'true' },
            h('line', { x1: 2, y1: 38, x2: 52, y2: 38, stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1 }),
            h('line', { x1: 2, y1: 4, x2: 52, y2: 4, stroke: 'rgba(255,255,255,0.08)', strokeDasharray: '2 2', strokeWidth: 1 }),
            h('path', { d, fill: 'none', stroke: '#88ce02', strokeWidth: 2, strokeLinecap: 'round' }),
            h('circle', { cx: 2, cy: 38, r: 2.5, fill: '#9ef01a' }),
            h('circle', { cx: 52, cy: 4, r: 2.5, fill: '#9ef01a' })
        );
    }

    function PresetGrid(props) {
        const inGroups = GROUPS.some((g) => g.slugs.indexOf(props.value) !== -1);
        const groups = inGroups ? GROUPS : GROUPS.concat([{ title: 'More', slugs: [props.value] }]);
        const allSlugs = groups.reduce((acc, g) => acc.concat(g.slugs), []);
        const gridRef = useRef(null);

        function onKeyDown(e, slug) {
            const idx = allSlugs.indexOf(slug);
            if (idx === -1) {
                return;
            }
            let nextIdx = -1;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                nextIdx = (idx + 1) % allSlugs.length;
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                nextIdx = (idx - 1 + allSlugs.length) % allSlugs.length;
            }
            if (nextIdx !== -1) {
                e.preventDefault();
                const nextSlug = allSlugs[nextIdx];
                props.onChange(nextSlug);
                const btn = gridRef.current && gridRef.current.querySelector('[data-slug="' + nextSlug + '"]');
                if (btn) {
                    btn.focus();
                }
            }
        }

        return h('div', { ref: gridRef, className: 'kwipa-presets', role: 'radiogroup', 'aria-label': 'Animation' },
            groups.map((group) => h('div', { key: group.title, className: 'kwipa-preset-group' },
                h('p', { className: 'kwipa-group-title' }, group.title),
                h('div', { className: 'kwipa-tiles' },
                    group.slugs.map((slug) => {
                        const isOn = props.value === slug;
                        return h('button', {
                            key: slug,
                            type: 'button',
                            role: 'radio',
                            'data-slug': slug,
                            tabIndex: isOn ? 0 : -1,
                            'aria-checked': isOn,
                            'data-anim': (MOTIONS[slug] && MOTIONS[slug].glyph) || slug,
                            className: 'kwipa-tile' + (isOn ? ' is-on' : ''),
                            onKeyDown: (e) => onKeyDown(e, slug),
                            onClick: () => props.onChange(slug),
                        },
                            h('span', { className: 'kwipa-glyph-box', 'aria-hidden': 'true' }, h('i', { className: 'kwipa-glyph' })),
                            h('span', { className: 'kwipa-tile-name' }, animLabel(slug)));
                    })
                )
            ))
        );
    }

    function VisualTimeline(props) {
        const layout = useMemo(
            () => computeTimelineLayout(props.steps, props.delay, props.stagger),
            [props.steps, props.delay, props.stagger]
        );
        const canAdd = props.steps.length < MAX_STEPS + 1;
        const marks = [0, 0.25, 0.5, 0.75, 1].map((t) => fmt(layout.total * t));

        return h('div', { className: 'kwipa-tl' },
            h('div', { className: 'kwipa-tl-head' },
                h('div', { className: 'kwipa-tl-title' },
                    h('span', null, 'Sequence timeline'),
                    h('span', { className: 'kwipa-tl-total' }, fmt(layout.activeEnd))
                ),
                h('button', {
                    type: 'button',
                    className: 'kwipa-btn kwipa-tl-add',
                    disabled: !canAdd,
                    onClick: props.onAddStep,
                }, '+ Add step')
            ),
            h('div', { className: 'kwipa-tl-board' },
                h('div', { className: 'kwipa-tl-ruler', 'aria-hidden': 'true' },
                    marks.map((m, i) => h('span', { key: i }, m))
                ),
                h('div', { className: 'kwipa-tl-lanes' },
                    h('div', { className: 'kwipa-tl-gridlines', 'aria-hidden': 'true' },
                        marks.map((_, i) => h('i', { key: i }))
                    ),
                    props.playNonce > 0 && h('div', {
                        key: props.playNonce,
                        className: 'kwipa-tl-playhead',
                        style: { '--kwipa-play-dur': Math.max(0.35, layout.total) + 's' },
                    }),
                    layout.bars.map((bar) => {
                        const isSelected = props.activeIndex === bar.index;
                        const hasCustomTarget = !!(bar.step.target && bar.step.target.trim());
                        const targetTag = hasCustomTarget ? bar.step.target.trim() : props.rootSelector;
                        const flowText = describeFlow(bar.index, bar.step.position, layout.delay);
                        const timeWindow = fmt(bar.start) + ' \u2192 ' + fmt(bar.end);

                        const leftPct = Math.min(86, (bar.start / layout.total) * 100);
                        const widthPct = Math.max(14, Math.min(100 - leftPct, (bar.duration / layout.total) * 100));
                        const delayPct = bar.index === 0 && layout.delay > 0 ? Math.min(leftPct, (layout.delay / layout.total) * 100) : 0;

                        return h('button', {
                            key: bar.index,
                            type: 'button',
                            'aria-pressed': isSelected,
                            className: 'kwipa-tl-item' + (isSelected ? ' is-selected' : ''),
                            onClick: () => props.onSelectStep(bar.index),
                        },
                            h('div', { className: 'kwipa-tl-meta' },
                                h('span', { className: 'kwipa-tl-idx' }, '0' + (bar.index + 1)),
                                h('span', {
                                    className: 'kwipa-tl-el-tag' + (hasCustomTarget ? ' is-custom' : ''),
                                    title: 'Element: ' + targetTag,
                                }, targetTag),
                                h('span', { className: 'kwipa-tl-flow-tag' }, flowText),
                                h('span', { className: 'kwipa-tl-time-tag' }, timeWindow)
                            ),
                            h('div', { className: 'kwipa-tl-track' },
                                delayPct > 0 && h('span', { className: 'kwipa-tl-delay-bar', style: { width: delayPct + '%' } }),
                                h('span', {
                                    className: 'kwipa-tl-bar is-c' + (bar.index % 4),
                                    style: { left: leftPct + '%', width: widthPct + '%' },
                                },
                                    h('span', { className: 'kwipa-tl-bar-name' }, animLabel(bar.step.animation)),
                                    h('span', { className: 'kwipa-tl-bar-dur' }, fmt(bar.duration))
                                )
                            )
                        );
                    })
                )
            )
        );
    }

    function TriggerPanel(props) {
        const s = props.settings;
        const steps = useMemo(() => (s ? toUnifiedSteps(s) : []), [s]);
        const safeIdx = Math.min(props.activeStep, Math.max(0, steps.length - 1));
        const activeStepObj = steps[safeIdx] || null;

        const motionSpec = activeStepObj && MOTIONS[activeStepObj.animation] ? MOTIONS[activeStepObj.animation] : null;
        const paramSpecs = motionSpec && motionSpec.params && typeof motionSpec.params === 'object' ? motionSpec.params : {};
        const paramKeys = Object.keys(paramSpecs);

        const sc = (s && s.scroll) || { start: 'top 85%', end: 'bottom 20%', scrub: false, pin: false, toggleActions: 'play none none none', trigger: '' };
        const isScrub = sc.scrub === true || (typeof sc.scrub === 'number' && sc.scrub > 0);

        function commitSteps(nextList, nextSelectedIdx) {
            props.onChange(fromUnifiedSteps(nextList));
            if (typeof nextSelectedIdx === 'number') {
                props.onSelectStep(nextSelectedIdx);
            }
        }

        function patchActiveStep(patch) {
            const nextList = steps.map((st, idx) => (idx === safeIdx ? Object.assign({}, st, patch) : st));
            commitSteps(nextList);
        }

        function addStep() {
            if (steps.length >= MAX_STEPS + 1) {
                return;
            }
            const nextSlug = data.animations.indexOf('scale-up') !== -1 ? 'scale-up' : data.animations[0];
            const nextList = steps.concat([{ animation: nextSlug, duration: 0.6, position: '>', ease: '', target: '' }]);
            commitSteps(nextList, nextList.length - 1);
        }

        function duplicateActiveStep() {
            if (steps.length >= MAX_STEPS + 1 || !activeStepObj) {
                return;
            }
            const copy = clone(activeStepObj);
            if (safeIdx === 0) {
                copy.position = '>';
            }
            const nextList = steps.slice(0, safeIdx + 1).concat([copy], steps.slice(safeIdx + 1));
            commitSteps(nextList, safeIdx + 1);
        }

        function moveActiveStep(delta) {
            const target = safeIdx + delta;
            if (target < 0 || target >= steps.length) {
                return;
            }
            const nextList = steps.slice();
            const moved = nextList[safeIdx];
            nextList[safeIdx] = nextList[target];
            nextList[target] = moved;
            nextList[0].position = '0';
            nextList[0].target = '';
            if (nextList[1] && nextList[1].position === '0') {
                nextList[1].position = '>';
            }
            commitSteps(nextList, target);
        }

        function removeActiveStep() {
            if (steps.length <= 1) {
                return;
            }
            const nextList = steps.filter((_, idx) => idx !== safeIdx);
            nextList[0].position = '0';
            nextList[0].target = '';
            commitSteps(nextList, Math.max(0, safeIdx - 1));
        }

        function patchScroll(patch) {
            props.onChange({ scroll: Object.assign({}, sc, patch) });
        }

        return h('div', { className: 'kwipa-panel' + (props.disabled ? ' is-disabled' : ''), role: 'tabpanel' },
            h('p', { className: 'kwipa-hint' }, TAB_HINTS[props.trigger]),
            h('div', { className: 'kwipa-switch-card' },
                h('label', { className: 'kwipa-switch' },
                    h('span', null, 'Enable ' + TAB_LABELS[props.trigger].toLowerCase() + ' motion'),
                    h('input', {
                        type: 'checkbox',
                        role: 'switch',
                        checked: !!s,
                        disabled: props.disabled,
                        onChange: (e) => (e.target.checked ? props.onEnable() : props.onDisable()),
                    }),
                    h('span', { className: 'kwipa-switch-ui', 'aria-hidden': 'true' })
                )
            ),
            s && activeStepObj && h(Fragment, null,
                h(VisualTimeline, {
                    steps,
                    rootSelector: props.rootSelector,
                    delay: s.delay || 0,
                    stagger: s.stagger || 0,
                    activeIndex: safeIdx,
                    playNonce: props.playNonce,
                    onSelectStep: props.onSelectStep,
                    onAddStep: addStep,
                }),

                h('div', { className: 'kwipa-step-inspector' },
                    h('div', { className: 'kwipa-step-bar' },
                        h('span', { className: 'kwipa-step-num' }, 'STEP 0' + (safeIdx + 1)),
                        h('span', { className: 'kwipa-step-heading' }, animLabel(activeStepObj.animation)),
                        h('div', { className: 'kwipa-step-tools' },
                            h('button', { type: 'button', className: 'kwipa-step-tool', title: 'Move earlier', disabled: safeIdx === 0, onClick: () => moveActiveStep(-1) }, '\u2191'),
                            h('button', { type: 'button', className: 'kwipa-step-tool', title: 'Move later', disabled: safeIdx === steps.length - 1, onClick: () => moveActiveStep(1) }, '\u2193'),
                            h('button', { type: 'button', className: 'kwipa-step-tool', title: 'Duplicate step', disabled: steps.length >= MAX_STEPS + 1, onClick: duplicateActiveStep }, '\u29c9'),
                            h('button', { type: 'button', className: 'kwipa-step-tool is-del', title: 'Remove step', disabled: steps.length <= 1, onClick: removeActiveStep }, '\u00d7')
                        )
                    ),

                    safeIdx > 0 && h(Fragment, null,
                        h('div', { className: 'kwipa-step-target-box' },
                            h('span', { className: 'kwipa-field-label' }, 'Element to animate in Step 0' + (safeIdx + 1)),
                            h('div', { className: 'kwipa-step-target-row' },
                                h('input', {
                                    type: 'text',
                                    placeholder: 'Same as Step 01 (' + props.rootSelector + ')',
                                    value: activeStepObj.target || '',
                                    onChange: (e) => patchActiveStep({ target: e.target.value }),
                                }),
                                h('button', {
                                    type: 'button',
                                    className: 'kwipa-btn kwipa-btn-dark kwipa-pick-btn' + (props.pickingStep ? ' is-picking' : ''),
                                    onClick: () => props.onTogglePickStep(!props.pickingStep),
                                }, props.pickingStep ? 'Click canvas\u2026' : 'Pick on canvas')
                            )
                        ),

                        h('div', { className: 'kwipa-field' },
                            h('span', { className: 'kwipa-field-label' }, 'When Step 0' + (safeIdx + 1) + ' plays'),
                            h('div', { className: 'kwipa-pos-pills', role: 'group', 'aria-label': 'Step timing offset' },
                                POSITION_PILLS.map((pill) => h('button', {
                                    key: pill.value,
                                    type: 'button',
                                    className: 'kwipa-pos-pill' + ((activeStepObj.position || '>') === pill.value ? ' is-active' : ''),
                                    onClick: () => patchActiveStep({ position: pill.value }),
                                }, pill.label))
                            )
                        )
                    ),

                    h(PresetGrid, {
                        value: activeStepObj.animation,
                        onChange: (slug) => patchActiveStep({ animation: slug, params: undefined }),
                    }),
                    data.libraryUrl && h('a', { className: 'kwipa-more', href: data.libraryUrl }, '+ Install or manage motion packs'),

                    paramKeys.length > 0 && h('div', { className: 'kwipa-slider-stack' },
                        paramKeys.map((key) => {
                            const spec = paramSpecs[key];
                            const currentVal = activeStepObj.params && Number.isFinite(activeStepObj.params[key]) ? activeStepObj.params[key] : spec.default;
                            return h(SliderNumberField, {
                                key: activeStepObj.animation + '-' + safeIdx + '-' + key,
                                id: 'kwipa-param-' + safeIdx + '-' + key,
                                label: spec.label || key,
                                value: currentVal,
                                min: spec.min,
                                max: spec.max,
                                step: spec.step || 1,
                                unit: spec.unit !== undefined ? spec.unit : '',
                                onChange: (v) => {
                                    const nextParams = Object.assign({}, activeStepObj.params || {});
                                    nextParams[key] = v;
                                    patchActiveStep({ params: nextParams });
                                },
                            });
                        })
                    ),

                    h(SliderNumberField, {
                        id: 'kwipa-step-duration-' + safeIdx,
                        label: 'Step duration',
                        value: activeStepObj.duration,
                        min: 0.05,
                        max: Math.min(10, data.limits.maxDuration),
                        step: 0.05,
                        unit: 's',
                        onChange: (v) => patchActiveStep({ duration: v }),
                    }),

                    h('div', { className: 'kwipa-ease-card', style: { marginTop: 0 } },
                        h(EaseCurvePreview, { ease: activeStepObj.ease || '' }),
                        h('label', { className: 'kwipa-field', htmlFor: 'kwipa-ease-' + safeIdx },
                            h('span', { className: 'kwipa-field-label' }, 'Step easing'),
                            h('select', {
                                id: 'kwipa-ease-' + safeIdx,
                                className: 'kwipa-select',
                                value: activeStepObj.ease || '',
                                onChange: (e) => patchActiveStep({ ease: e.target.value }),
                            }, Object.keys(EASES).map((k) => h('option', { key: k || 'default', value: k }, EASES[k])))
                        )
                    )
                ),

                props.trigger === 'scroll' && h('fieldset', { className: 'kwipa-fieldset' },
                    h('legend', null, 'ScrollTrigger'),
                    h('div', { className: 'kwipa-scroll-box' },
                        h('label', { className: 'kwipa-check-row' },
                            h('input', {
                                type: 'checkbox',
                                checked: isScrub,
                                onChange: (e) => patchScroll({ scrub: e.target.checked ? 1 : false }),
                            }),
                            h('span', null, 'Scrub with scroll progress (Parallax)')
                        ),
                        isScrub && h('label', { className: 'kwipa-field' },
                            h('span', { className: 'kwipa-field-label' }, 'Scrub smoothing'),
                            h('select', {
                                className: 'kwipa-select',
                                value: sc.scrub === true ? 'true' : String(sc.scrub || 1),
                                onChange: (e) => patchScroll({ scrub: e.target.value === 'true' ? true : parseFloat(e.target.value) }),
                            },
                                h('option', { value: 'true' }, 'Direct (0s lock)'),
                                h('option', { value: '0.5' }, '0.5s smooth'),
                                h('option', { value: '1' }, '1.0s smooth'),
                                h('option', { value: '2' }, '2.0s silky')
                            )
                        ),
                        h('div', { className: 'kwipa-row' },
                            h('label', { className: 'kwipa-field' },
                                h('span', { className: 'kwipa-field-label' }, 'Start'),
                                h('select', {
                                    className: 'kwipa-select',
                                    value: sc.start || 'top 85%',
                                    onChange: (e) => patchScroll({ start: e.target.value }),
                                }, Object.keys(SCROLL_OPTS.starts).map((k) => h('option', { key: k, value: k }, SCROLL_OPTS.starts[k])))
                            ),
                            h('label', { className: 'kwipa-field' },
                                h('span', { className: 'kwipa-field-label' }, 'End'),
                                h('select', {
                                    className: 'kwipa-select',
                                    value: sc.end || 'bottom 20%',
                                    onChange: (e) => patchScroll({ end: e.target.value }),
                                }, Object.keys(SCROLL_OPTS.ends).map((k) => h('option', { key: k, value: k }, SCROLL_OPTS.ends[k])))
                            )
                        ),
                        !isScrub && h('label', { className: 'kwipa-field' },
                            h('span', { className: 'kwipa-field-label' }, 'Playback behavior'),
                            h('select', {
                                className: 'kwipa-select',
                                value: sc.toggleActions || 'play none none none',
                                onChange: (e) => patchScroll({ toggleActions: e.target.value }),
                            }, Object.keys(SCROLL_OPTS.toggleActions).map((k) => h('option', { key: k, value: k }, SCROLL_OPTS.toggleActions[k])))
                        ),
                        h('label', { className: 'kwipa-check-row' },
                            h('input', {
                                type: 'checkbox',
                                checked: !!sc.pin,
                                onChange: (e) => patchScroll({ pin: e.target.checked }),
                            }),
                            h('span', null, 'Pin element while scrolling')
                        ),
                        h('label', { className: 'kwipa-check-row' },
                            h('input', {
                                type: 'checkbox',
                                checked: !!props.showMarkers,
                                onChange: (e) => props.onToggleMarkers(e.target.checked),
                            }),
                            h('span', null, 'Show ScrollTrigger markers in preview')
                        ),
                        h('label', { className: 'kwipa-field' },
                            h('span', { className: 'kwipa-field-label' }, 'Custom trigger selector'),
                            h('input', {
                                type: 'text',
                                className: 'kwipa-select',
                                placeholder: 'Defaults to selected element',
                                value: sc.trigger || '',
                                onChange: (e) => patchScroll({ trigger: e.target.value }),
                            })
                        )
                    )
                ),

                h('fieldset', { className: 'kwipa-fieldset' },
                    h('legend', null, 'Trigger timing & devices'),
                    h('div', { className: 'kwipa-row' },
                        h(CompactNumberField, { id: 'kwipa-delay', label: 'Start delay', value: s.delay || 0, min: 0, max: data.limits.maxDelay, step: 0.1, onChange: (v) => props.onChange({ delay: v }) }),
                        h(CompactNumberField, { id: 'kwipa-stagger', label: 'Group stagger', value: s.stagger || 0, min: 0, max: data.limits.maxStagger || 5, step: 0.05, onChange: (v) => props.onChange({ stagger: v }) })
                    ),
                    h('label', { className: 'kwipa-field', htmlFor: 'kwipa-bp', style: { marginTop: '10px' } },
                        h('span', { className: 'kwipa-field-label' }, 'Responsive devices'),
                        h('select', {
                            id: 'kwipa-bp',
                            className: 'kwipa-select',
                            value: s.breakpoint || 'all',
                            onChange: (e) => props.onChange({ breakpoint: e.target.value }),
                        }, Object.keys(BREAKPOINTS).map((k) => h('option', { key: k, value: k }, BREAKPOINTS[k])))
                    )
                ),

                h('div', { className: 'kwipa-actions' },
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-dark', disabled: props.previewDisabled, onClick: props.onPreview }, 'Play preview'),
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', disabled: props.previewDisabled, onClick: props.onReset }, 'Reset'),
                    h('label', { className: 'kwipa-auto' },
                        h('input', { type: 'checkbox', checked: props.autoPreview, onChange: (e) => props.onAutoPreview(e.target.checked) }),
                        h('span', null, 'Auto-preview')
                    )
                )
            )
        );
    }

    function JsonTransferModal(props) {
        const [mode, setMode] = useState('export');
        const [rawText, setRawText] = useState('');
        const [importStrategy, setImportStrategy] = useState('merge');
        const [localError, setLocalError] = useState('');
        const exportJson = useMemo(() => JSON.stringify(prepareScoped(props.doc), null, 2), [props.doc]);

        function downloadFile() {
            const blob = new Blob([exportJson], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = 'kwip-animation-' + stamp + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function copyJson() {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(exportJson);
            }
            props.onNotify({ type: 'success', text: 'Configuration JSON copied to clipboard.' });
        }

        function handleFile(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) {
                return;
            }
            const reader = new FileReader();
            reader.onload = () => setRawText(String(reader.result || ''));
            reader.readAsText(file);
        }

        function runImport() {
            setLocalError('');
            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch (e) {
                setLocalError('Invalid JSON syntax.');
                return;
            }
            const normalized = prepareScoped(normalizeScoped(parsed));
            if (!Object.keys(normalized.scopes).length) {
                setLocalError('No valid scopes or selectors found in this JSON.');
                return;
            }
            props.onImport(normalized, importStrategy);
            props.onClose();
        }

        return h('div', {
            className: 'kwipa-modal-backdrop',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'Export or import configuration',
            onClick: (e) => { if (e.target === e.currentTarget) { props.onClose(); } },
        },
            h('div', { className: 'kwipa-modal' },
                h('div', { className: 'kwipa-modal-head' },
                    h('h2', null, 'Transfer animation configuration'),
                    h('button', { type: 'button', className: 'kwipa-notice-x', 'aria-label': 'Close', onClick: props.onClose }, '\u00d7')
                ),
                h('div', { className: 'kwipa-modal-tabs' },
                    h('button', {
                        type: 'button',
                        className: 'kwipa-dev-btn' + (mode === 'export' ? ' is-active' : ''),
                        onClick: () => setMode('export'),
                    }, 'Export JSON'),
                    h('button', {
                        type: 'button',
                        className: 'kwipa-dev-btn' + (mode === 'import' ? ' is-active' : ''),
                        onClick: () => setMode('import'),
                    }, 'Import JSON')
                ),
                mode === 'export'
                    ? h(Fragment, null,
                        h('textarea', { className: 'kwipa-modal-textarea', readOnly: true, value: exportJson }),
                        h('div', { className: 'kwipa-modal-foot' },
                            h('span', { className: 'kwipa-hint' }, 'Portable v2 scoped schema.'),
                            h('div', { className: 'kwipa-modal-btns' },
                                h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', onClick: copyJson }, 'Copy JSON'),
                                h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-primary', onClick: downloadFile }, 'Download .json')
                            )
                        )
                    )
                    : h(Fragment, null,
                        localError && h('p', { className: 'kwipa-notice is-error', style: { margin: '0 0 10px' } }, localError),
                        h('div', { className: 'kwipa-row', style: { marginBottom: '10px', alignItems: 'center' } },
                            h('input', { type: 'file', accept: '.json,application/json', onChange: handleFile, style: { color: 'var(--kwipa-muted)', fontSize: '12px' } }),
                            h('select', {
                                className: 'kwipa-select',
                                value: importStrategy,
                                onChange: (e) => setImportStrategy(e.target.value),
                            },
                                h('option', { value: 'merge' }, 'Merge with existing rules'),
                                h('option', { value: 'replace' }, 'Replace entire configuration')
                            )
                        ),
                        h('textarea', {
                            className: 'kwipa-modal-textarea',
                            placeholder: 'Paste exported KWIP Animation JSON here\u2026',
                            value: rawText,
                            onChange: (e) => setRawText(e.target.value),
                        }),
                        h('div', { className: 'kwipa-modal-foot' },
                            h('span', { className: 'kwipa-hint' }, 'Supports Undo (Ctrl+Z) after importing.'),
                            h('div', { className: 'kwipa-modal-btns' },
                                h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', onClick: props.onClose }, 'Cancel'),
                                h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-primary', disabled: !rawText.trim(), onClick: runImport }, 'Import rules')
                            )
                        )
                    )
            )
        );
    }

    function App() {
        const initial = useMemo(() => normalizeScoped(data.config), []);

        const [doc, setDoc] = useState(initial);
        const [saved, setSaved] = useState(initial);
        const [past, setPast] = useState([]);
        const [future, setFuture] = useState([]);
        const [transferOpen, setTransferOpen] = useState(false);

        const [scopeMode, setScopeMode] = useState('page');
        const [activePath, setActivePath] = useState('/');
        const [viewport, setViewport] = useState('desktop');
        const [selected, setSelected] = useState('');
        const [selectorDraft, setSelectorDraft] = useState('');
        const [selectedLabel, setSelectedLabel] = useState('');
        const [ancestors, setAncestors] = useState([]);
        const [matchCount, setMatchCount] = useState(null);
        const [tab, setTab] = useState(TABS[0]);
        const [activeStep, setActiveStep] = useState(0);
        const [pickingStep, setPickingStep] = useState(false);
        const [playNonce, setPlayNonce] = useState(0);

        const [pageInput, setPageInput] = useState('/');
        const [frameNonce, setFrameNonce] = useState(data.frame.nonce);
        const [frameSrc, setFrameSrc] = useState(() => (originOk ? buildFrameUrl('/', data.frame.nonce) : null));
        const [frameKey, setFrameKey] = useState(0);
        const [bridge, setBridge] = useState({ state: 'loading', gsap: false, scrollTrigger: false });
        const [notice, setNotice] = useState(null);
        const [autoPreview, setAutoPreview] = useState(true);
        const [showMarkers, setShowMarkers] = useState(true);
        const [saving, setSaving] = useState(false);

        const iframeRef = useRef(null);
        const selectedRef = useRef('');
        const pickStepRef = useRef(null);
        const previewTimer = useRef(0);
        const watchdog = useRef(0);
        const saveRef = useRef(null);
        const undoRef = useRef(null);
        const redoRef = useRef(null);
        selectedRef.current = selected;

        const currentScopeKey = scopeMode === 'global' ? 'global' : 'path:' + activePath;
        const pageScopeKey = 'path:' + activePath;
        const config = (doc.scopes && doc.scopes[currentScopeKey]) || {};
        const pageRuleCount = Object.keys((doc.scopes && doc.scopes[pageScopeKey]) || {}).length;
        const globalRuleCount = Object.keys((doc.scopes && doc.scopes.global) || {}).length;

        const dirty = useMemo(() => JSON.stringify(prepareScoped(doc)) !== JSON.stringify(prepareScoped(saved)), [doc, saved]);

        function commitDoc(nextDoc) {
            setDoc((prev) => {
                setPast((p) => p.slice(-(MAX_HISTORY - 1)).concat([clone(prev)]));
                setFuture([]);
                return nextDoc;
            });
        }

        function undo() {
            if (!past.length) {
                return;
            }
            const previous = past[past.length - 1];
            setPast((p) => p.slice(0, -1));
            setFuture((f) => [clone(doc)].concat(f.slice(0, MAX_HISTORY - 1)));
            setDoc(previous);
            send('clear');
        }

        function redo() {
            if (!future.length) {
                return;
            }
            const next = future[0];
            setFuture((f) => f.slice(1));
            setPast((p) => p.slice(-(MAX_HISTORY - 1)).concat([clone(doc)]));
            setDoc(next);
            send('clear');
        }

        undoRef.current = undo;
        redoRef.current = redo;

        function updateCurrentScope(updater) {
            const nextScopes = Object.assign({}, doc.scopes);
            const prevScopeRules = Object.assign({}, nextScopes[currentScopeKey] || {});
            const updatedRules = updater(prevScopeRules);
            if (Object.keys(updatedRules).length) {
                nextScopes[currentScopeKey] = updatedRules;
            } else {
                delete nextScopes[currentScopeKey];
            }
            commitDoc({ version: 2, scopes: nextScopes });
        }

        function send(type, extra) {
            const win = iframeRef.current && iframeRef.current.contentWindow;
            if (win) {
                win.postMessage(Object.assign({ source: MSG_TO_FRAME, type }, extra), frameOrigin);
            }
        }

        const current = selected && config[selected] ? config[selected][tab] || null : null;

        function applyTrigger(selector, trigger, value) {
            updateCurrentScope((rules) => {
                const next = Object.assign({}, rules);
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

        function previewNow(selector, trigger, s, markersOverride) {
            const markersFlag = markersOverride !== undefined ? markersOverride : showMarkers;
            const scrollPayload = s.scroll ? Object.assign({}, s.scroll, { markers: markersFlag }) : { markers: markersFlag };
            setPlayNonce((n) => n + 1);
            send('preview', {
                selector,
                trigger,
                settings: {
                    animation: s.animation,
                    duration: s.duration,
                    delay: s.delay || 0,
                    stagger: s.stagger || 0,
                    ease: s.ease || '',
                    breakpoint: s.breakpoint || 'all',
                    params: s.params || undefined,
                    steps: Array.isArray(s.steps) && s.steps.length ? s.steps : undefined,
                    scroll: trigger === 'scroll' ? scrollPayload : undefined,
                },
            });
        }

        function schedulePreview(selector, trigger, s) {
            if (!autoPreview) {
                return;
            }
            clearTimeout(previewTimer.current);
            previewTimer.current = setTimeout(() => previewNow(selector, trigger, s), 350);
        }

        function changeTrigger(patch) {
            const s = Object.assign({}, current, patch);
            applyTrigger(selected, tab, s);
            schedulePreview(selected, tab, s);
        }

        pickStepRef.current = function (pickedSelector) {
            if (!pickingStep || !current || activeStep <= 0) {
                return false;
            }
            const unified = toUnifiedSteps(current);
            if (!unified[activeStep]) {
                setPickingStep(false);
                return false;
            }
            unified[activeStep].target = pickedSelector;
            changeTrigger(fromUnifiedSteps(unified));
            setPickingStep(false);
            if (selectedRef.current) {
                send('highlight', { selector: selectedRef.current });
            }
            return true;
        };

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
                    if (isSelectorValid(msg.selector)) {
                        if (pickStepRef.current && pickStepRef.current(msg.selector)) {
                            return;
                        }
                        setSelected(msg.selector);
                        setSelectorDraft(msg.selector);
                        setSelectedLabel(typeof msg.label === 'string' ? msg.label.slice(0, 120) : '');
                        setAncestors(Array.isArray(msg.ancestors) ? msg.ancestors : []);
                        setMatchCount(typeof msg.matches === 'number' ? msg.matches : 1);
                        setActiveStep(0);
                        setPickingStep(false);
                    }
                } else if (msg.type === 'matched') {
                    if (msg.selector === selectedRef.current) {
                        setMatchCount(typeof msg.matches === 'number' ? msg.matches : 0);
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

        async function refreshFrameNonce() {
            try {
                const res = await fetch(data.rest.restUrl.replace(/\/$/, '') + '/frame-nonce', {
                    credentials: 'same-origin',
                    headers: {
                        'X-WP-Nonce': data.rest.restNonce,
                        'X-KWIPA-Nonce': data.rest.kwipNonce,
                    },
                });
                if (res.ok) {
                    const json = await res.json();
                    if (json && json.nonce) {
                        setFrameNonce(json.nonce);
                        return json.nonce;
                    }
                }
            } catch (e) {
                // Fall back to existing nonce.
            }
            return frameNonce;
        }

        async function loadPage(targetPath) {
            const norm = normalizePath(targetPath);
            const freshNonce = await refreshFrameNonce();
            const url = buildFrameUrl(targetPath, freshNonce);
            if (!url) {
                setNotice({ type: 'error', text: 'Enter a page on this site, for example / or /about/.' });
                return;
            }
            setPageInput(targetPath);
            setActivePath(norm);
            setNotice(null);
            setBridge({ state: 'loading', gsap: false, scrollTrigger: false });
            setFrameSrc(url);
            setFrameKey((k) => k + 1);
        }

        function navigate(e) {
            e.preventDefault();
            loadPage(pageInput);
        }

        function applySelectorEdit(e) {
            e.preventDefault();
            const clean = selectorDraft.trim().replace(/\s+/g, ' ');
            if (!isSelectorValid(clean)) {
                setNotice({ type: 'error', text: 'Invalid or disallowed CSS selector.' });
                return;
            }
            if (clean === selected) {
                send('highlight', { selector: clean });
                return;
            }
            updateCurrentScope((rules) => {
                if (!rules[selected]) {
                    return rules;
                }
                const next = Object.assign({}, rules);
                next[clean] = Object.assign({}, next[clean] || {}, next[selected]);
                delete next[selected];
                return next;
            });
            setSelected(clean);
            setSelectorDraft(clean);
            setSelectedLabel('Custom selector');
            send('highlight', { selector: clean });
        }

        function enableTrigger() {
            const s = defaultSettings(tab);
            setActiveStep(0);
            setPickingStep(false);
            applyTrigger(selected, tab, s);
            schedulePreview(selected, tab, s);
        }

        function disableTrigger() {
            setPickingStep(false);
            applyTrigger(selected, tab, null);
            clearTimeout(previewTimer.current);
            send('clear', { selector: selected });
        }

        function pick(selector, keepAncestors) {
            setSelected(selector);
            setSelectorDraft(selector);
            setSelectedLabel('');
            setActiveStep(0);
            setPickingStep(false);
            if (!keepAncestors) {
                setAncestors([]);
            }
            send('highlight', { selector });
        }

        function removeElement(selector) {
            updateCurrentScope((rules) => {
                const next = Object.assign({}, rules);
                delete next[selector];
                return next;
            });
            send('clear', { selector });
        }

        function discard() {
            commitDoc(clone(saved));
            send('clear');
            setNotice({ type: 'info', text: 'Reverted to last published state.' });
        }

        function handleImport(importedScoped, strategy) {
            if (strategy === 'replace') {
                commitDoc(importedScoped);
            } else {
                const mergedScopes = clone(doc.scopes || {});
                Object.keys(importedScoped.scopes).forEach((scopeKey) => {
                    mergedScopes[scopeKey] = Object.assign({}, mergedScopes[scopeKey] || {}, importedScoped.scopes[scopeKey]);
                });
                commitDoc({ version: 2, scopes: mergedScopes });
            }
            send('clear');
            setNotice({ type: 'success', text: 'Imported rules into draft. Click Save changes to publish.' });
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
                    body: JSON.stringify({ config: prepareScoped(doc) }),
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

                const next = normalizeScoped(body && body.config);
                setDoc(next);
                setSaved(next);
                setNotice({ type: 'success', text: 'Animations published.' });
            } catch (err) {
                setNotice({ type: 'error', text: err && err.message ? err.message : 'Save failed.' });
            } finally {
                setSaving(false);
            }
        }
        saveRef.current = save;

        useEffect(() => {
            function onKey(e) {
                if (e.key === 'Escape' && pickingStep) {
                    setPickingStep(false);
                    return;
                }
                const mod = e.ctrlKey || e.metaKey;
                if (!mod) {
                    return;
                }
                const key = String(e.key).toLowerCase();
                if (key === 's') {
                    e.preventDefault();
                    saveRef.current();
                    return;
                }
                const tag = document.activeElement && document.activeElement.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                    return;
                }
                if (key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    undoRef.current();
                } else if ((key === 'z' && e.shiftKey) || key === 'y') {
                    e.preventDefault();
                    redoRef.current();
                }
            }
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }, [pickingStep]);

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
            loading: 'Connecting\u2026',
            ready: bridge.gsap ? 'Canvas live' : 'GSAP missing',
            silent: 'Canvas offline',
        }[bridge.state];

        const elementKeys = Object.keys(config);
        const sitePages = Array.isArray(data.pages) ? data.pages : [];

        return h('div', { className: 'kwipa-app' },
            transferOpen && h(JsonTransferModal, {
                doc,
                onClose: () => setTransferOpen(false),
                onImport: handleImport,
                onNotify: setNotice,
            }),
            h('aside', { className: 'kwipa-sidebar' },
                h('header', { className: 'kwipa-head' },
                    h('div', { className: 'kwipa-brand' },
                        h('div', { className: 'kwipa-brand-id' },
                            h(StudioLogo),
                            h('h1', null, 'KWIP Animation'),
                            h('span', { className: 'kwipa-ver' }, 'STUDIO')
                        ),
                        h('span', { className: 'kwipa-state' + (dirty ? ' is-dirty' : '') }, h('i', { 'aria-hidden': 'true' }), dirty ? 'Unsaved' : 'Synced')
                    ),
                    h('div', { className: 'kwipa-head-actions' },
                        h('button', { type: 'button', className: 'kwipa-icon-btn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', disabled: !past.length, onClick: undo }, '\u21a9'),
                        h('button', { type: 'button', className: 'kwipa-icon-btn', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', disabled: !future.length, onClick: redo }, '\u21aa'),
                        h('button', { type: 'button', className: 'kwipa-icon-btn', title: 'Export / Import JSON', 'aria-label': 'Export or import JSON', onClick: () => setTransferOpen(true) }, '\u21c5'),
                        h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', disabled: !dirty || saving, onClick: discard }, 'Discard'),
                        h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-primary', disabled: !dirty || saving, onClick: save }, saving ? 'Publishing\u2026' : 'Save changes')
                    )
                ),

                h('div', { className: 'kwipa-scroll' },
                    notice && h(Notice, { type: notice.type, text: notice.text, onDismiss: () => setNotice(null) }),

                    h('section', { className: 'kwipa-section' },
                        h('div', { className: 'kwipa-scope-bar', role: 'group', 'aria-label': 'Rule scope' },
                            h('button', {
                                type: 'button',
                                className: 'kwipa-scope-btn' + (scopeMode === 'page' ? ' is-active' : ''),
                                onClick: () => setScopeMode('page'),
                            }, h('span', null, 'Page ' + activePath), h('span', { className: 'kwipa-count' }, pageRuleCount)),
                            h('button', {
                                type: 'button',
                                className: 'kwipa-scope-btn' + (scopeMode === 'global' ? ' is-active' : ''),
                                onClick: () => setScopeMode('global'),
                            }, h('span', null, 'Global site'), h('span', { className: 'kwipa-count' }, globalRuleCount))
                        ),
                        h('h2', null,
                            'Target element',
                            selected && matchCount !== null && h('span', { className: 'kwipa-match-pill' + (matchCount === 0 ? ' is-zero' : '') }, matchCount + (matchCount === 1 ? ' match' : ' matches'))
                        ),
                        selected
                            ? h(Fragment, null,
                                ancestors.length > 1 && h('div', { className: 'kwipa-breadcrumbs', 'aria-label': 'DOM hierarchy' },
                                    ancestors.map((item) => h('button', {
                                        key: item.selector,
                                        type: 'button',
                                        className: 'kwipa-crumb' + (item.selector === selected ? ' is-current' : ''),
                                        title: item.selector,
                                        onClick: () => pick(item.selector, true),
                                    }, item.label))
                                ),
                                h('form', { className: 'kwipa-selector-edit', onSubmit: applySelectorEdit },
                                    h('input', {
                                        type: 'text',
                                        value: selectorDraft,
                                        'aria-label': 'Target CSS selector',
                                        onChange: (e) => setSelectorDraft(e.target.value),
                                    }),
                                    h('button', { type: 'submit', className: 'kwipa-btn kwipa-btn-dark' }, 'Apply')
                                ),
                                selectedLabel && h('p', { className: 'kwipa-label' }, selectedLabel))
                            : h('div', { className: 'kwipa-empty-card' },
                                h('span', { className: 'kwipa-empty-icon', 'aria-hidden': 'true' },
                                    h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                                        h('path', { d: 'M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z' }),
                                        h('path', { d: 'M13 13l6 6' })
                                    )
                                ),
                                h('div', null,
                                    h('p', { className: 'kwipa-empty' }, 'Select an element on the canvas'),
                                    h('p', { className: 'kwipa-hint' }, 'Click any heading, image, card, or button to choreograph its motion.')
                                )
                            )
                    ),

                    h('section', { className: 'kwipa-section' },
                        h('div', { className: 'kwipa-tabs', role: 'tablist' },
                            TABS.map((t) => h('button', {
                                key: t,
                                type: 'button',
                                role: 'tab',
                                'aria-selected': tab === t,
                                className: 'kwipa-tab' + (tab === t ? ' is-active' : ''),
                                onClick: () => { setTab(t); setActiveStep(0); setPickingStep(false); },
                            }, TAB_LABELS[t], selected && config[selected] && config[selected][t] ? h('i', { className: 'kwipa-dot', 'aria-label': 'enabled' }) : null))
                        ),
                        h(TriggerPanel, {
                            trigger: tab,
                            rootSelector: selected,
                            settings: current,
                            activeStep,
                            pickingStep,
                            playNonce,
                            disabled: !selected,
                            previewDisabled: bridge.state !== 'ready',
                            autoPreview,
                            showMarkers,
                            onSelectStep: (idx) => { setActiveStep(idx); setPickingStep(false); },
                            onTogglePickStep: setPickingStep,
                            onToggleMarkers: (val) => {
                                setShowMarkers(val);
                                if (current && tab === 'scroll') {
                                    previewNow(selected, tab, current, val);
                                }
                            },
                            onAutoPreview: setAutoPreview,
                            onEnable: enableTrigger,
                            onDisable: disableTrigger,
                            onChange: changeTrigger,
                            onPreview: () => current && previewNow(selected, tab, current),
                            onReset: () => send('clear', { selector: selected }),
                        })
                    ),

                    h('section', { className: 'kwipa-section' },
                        h('h2', null, scopeMode === 'global' ? 'Global animated layers' : 'Page animated layers', h('span', { className: 'kwipa-count' }, elementKeys.length)),
                        elementKeys.length
                            ? h('ul', { className: 'kwipa-list' }, elementKeys.map((selector) => h('li', { key: selector, className: 'kwipa-item' + (selector === selected ? ' is-active' : '') },
                                h('button', { type: 'button', className: 'kwipa-item-main', onClick: () => pick(selector, false) },
                                    h('code', { title: selector }, selector),
                                    h('span', { className: 'kwipa-badges' }, TABS.filter((t) => config[selector][t]).map((t) => h('span', { key: t, className: 'kwipa-badge' }, t)))
                                ),
                                h('button', { type: 'button', className: 'kwipa-item-del', 'aria-label': 'Remove all animations from ' + selector, onClick: () => removeElement(selector) }, '\u00d7')
                            )))
                            : h('p', { className: 'kwipa-hint' }, 'No animated layers in this scope yet.')
                    )
                )
            ),

            h('main', { className: 'kwipa-stage' },
                h('form', { className: 'kwipa-bar', onSubmit: navigate },
                    h('span', { className: 'kwipa-bar-label' }, 'Artboard'),
                    sitePages.length > 1 && h('select', {
                        'aria-label': 'Quick page select',
                        value: sitePages.some((p) => normalizePath(p.path) === activePath) ? sitePages.find((p) => normalizePath(p.path) === activePath).path : '',
                        disabled: !originOk,
                        onChange: (e) => e.target.value && loadPage(e.target.value),
                    },
                        h('option', { value: '' }, 'Jump to page\u2026'),
                        sitePages.map((p) => h('option', { key: p.path, value: p.path }, p.title))
                    ),
                    h('input', { id: 'kwipa-page', type: 'text', value: pageInput, placeholder: '/ or /about/', disabled: !originOk, onChange: (e) => setPageInput(e.target.value) }),
                    h('button', { type: 'submit', className: 'kwipa-btn kwipa-btn-dark', disabled: !originOk }, 'Load'),

                    h('div', { className: 'kwipa-devices', role: 'group', 'aria-label': 'Preview viewport' },
                        [
                            { id: 'desktop', label: 'Desktop' },
                            { id: 'tablet', label: '768px' },
                            { id: 'mobile', label: '390px' },
                        ].map((d) => h('button', {
                            key: d.id,
                            type: 'button',
                            className: 'kwipa-dev-btn' + (viewport === d.id ? ' is-active' : ''),
                            onClick: () => setViewport(d.id),
                        }, d.label))
                    ),

                    h('span', { className: 'kwipa-status is-' + bridge.state }, h('i', { 'aria-hidden': 'true' }), statusText)
                ),
                !originOk
                    ? h('div', { className: 'kwipa-blocked' },
                        h('h2', null, 'Preview unavailable'),
                        h('p', null, 'This admin page is open on ' + window.location.origin + ', but the site lives on ' + frameOrigin + '. The builder only talks to a preview on the same origin.'),
                        h('p', null, 'Open wp-admin from the site address, or make the WordPress Address and Site Address use the same domain.'))
                    : frameSrc
                        ? h('div', { className: 'kwipa-canvas' },
                            h('iframe', {
                                key: frameKey,
                                ref: iframeRef,
                                className: 'kwipa-frame is-' + viewport,
                                src: frameSrc,
                                title: 'Site preview',
                                sandbox: 'allow-scripts allow-same-origin',
                                referrerPolicy: 'same-origin',
                                onLoad: onFrameLoad,
                            })
                        )
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