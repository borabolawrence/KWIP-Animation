/**
 * KWIP Animation - Inspector Bridge
 *
 * Runs ONLY inside the builder iframe (Step 3 enqueues it there; the public
 * site never loads this file).
 *
 * Messages iframe -> parent (all carry source: 'kwipa-inspector'):
 *   ready           { gsap, scrollTrigger }
 *   select          { selector, tag, id, classes, label }
 *   preview-started { selector, trigger, matches }
 *   error           { code, message }
 *
 * Messages parent -> iframe (must carry source: 'kwipa-builder'):
 *   ping                                   -> replies with 'ready'
 *   highlight { selector|null }            -> persistent outline (null clears)
 *   preview   { selector, trigger, settings: { animation, duration, delay } }
 *   clear     { selector? }                -> kill previews, restore elements
 *
 * Config (optional, printed by PHP before this file):
 *   window.KWIPABridgeConfig = { parentOrigin: 'https://example.com' }
 */
(function () {
    'use strict';

    if (window.parent === window || window.__KWIPA_INSPECTOR__) {
        return;
    }
    window.__KWIPA_INSPECTOR__ = true;

    const cfg = window.KWIPABridgeConfig || {};
    const PARENT_ORIGIN = (typeof cfg.parentOrigin === 'string' && cfg.parentOrigin) ? cfg.parentOrigin : window.location.origin;
    const MSG_OUT = 'kwipa-inspector';
    const MSG_IN = 'kwipa-builder';
    const TRIGGERS = ['load', 'hover', 'scroll', 'click'];
    const MAX_LEN = 255;

    const SELECTOR_OK = /^[\p{L}\p{N}_\-#.>+~:()*\\\/ ]+$/u;

    const STATE_CLASS = /^(active|current|open|opened|show|shown|hide|hidden|visible|hover|focus|focused|selected|disabled|loading|loaded|ready|animated|in-?view|is-[\w-]+|aos-[\w-]+|kwipa-[\w-]+)$/i;
    const UNSTABLE = /\d{5,}|^(css|sc|jsx|svelte|emotion|styled)-[a-z0-9]+$/i;

    /**
     * Animation presets. Slugs must match KWIPA_Config::allowed_animations().
     *   entrance: animates FROM the given state TO the element's natural state.
     *   effect:   animates from natural TO the given state (legs > 1 = yoyo back).
     *   hold:     on hover, stays in the target state until mouseleave.
     */
    const PRESETS = {
        'fade-in': { kind: 'entrance', from: { opacity: 0 } },
        'fade-up': { kind: 'entrance', from: { opacity: 0, y: 40 } },
        'fade-down': { kind: 'entrance', from: { opacity: 0, y: -40 } },
        'fade-left': { kind: 'entrance', from: { opacity: 0, x: 40 } },
        'fade-right': { kind: 'entrance', from: { opacity: 0, x: -40 } },
        'scale-up': { kind: 'effect', to: { scale: 1.1 }, legs: 2, hold: true },
        'scale-down': { kind: 'effect', to: { scale: 0.9 }, legs: 2, hold: true },
        'pulse': { kind: 'effect', to: { scale: 1.12 }, legs: 4 },
        'spin': { kind: 'effect', to: { rotation: '+=360' }, ease: 'power2.inOut' },
        'flip-x': { kind: 'effect', to: { rotationX: '+=360', transformPerspective: 600 }, ease: 'power2.inOut' },
        'flip-y': { kind: 'effect', to: { rotationY: '+=360', transformPerspective: 600 }, ease: 'power2.inOut' },
        'shake': { kind: 'effect', keyframes: { x: [-10, 10, -8, 8, -4, 4, 0], easeEach: 'sine.inOut' } },
    };


    function post(payload) {
        payload.source = MSG_OUT;
        try {
            window.parent.postMessage(payload, PARENT_ORIGIN);
        } catch (e) {
            // Parent is gone; nothing to do.
        }
    }

    function fail(code, message) {
        post({ type: 'error', code, message });
    }


    function esc(value) {
        return (window.CSS && CSS.escape) ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
    }

    function isUnique(selector, el) {
        if (selector.length > MAX_LEN || !SELECTOR_OK.test(selector)) {
            return false;
        }
        try {
            const found = document.querySelectorAll(selector);
            return found.length === 1 && found[0] === el;
        } catch (e) {
            return false;
        }
    }

    function stableId(el) {
        const id = el.getAttribute('id');
        if (!id || UNSTABLE.test(id)) {
            return '';
        }
        const token = '#' + esc(id);
        if (!SELECTOR_OK.test(token)) {
            return '';
        }
        try {
            return document.querySelectorAll(token).length === 1 ? token : '';
        } catch (e) {
            return '';
        }
    }

    function stableClasses(el) {
        const out = [];
        Array.prototype.forEach.call(el.classList, (name) => {
            if (STATE_CLASS.test(name) || UNSTABLE.test(name)) {
                return;
            }
            const token = '.' + esc(name);
            if (SELECTOR_OK.test(token)) {
                out.push(token);
            }
        });
        return out;
    }

    function simpleCandidates(el) {
        const tag = SELECTOR_OK.test(el.localName) ? el.localName : '';
        const id = stableId(el);
        const classes = stableClasses(el).slice(0, 6);
        const list = [];

        if (id) {
            list.push(id);
        }
        classes.forEach((c) => list.push(c));
        if (tag) {
            classes.forEach((c) => list.push(tag + c));
        }
        for (let i = 0; i < classes.length; i++) {
            for (let j = i + 1; j < classes.length; j++) {
                list.push(classes[i] + classes[j]);
                if (tag) {
                    list.push(tag + classes[i] + classes[j]);
                }
            }
        }
        if (tag) {
            list.push(tag);
        }
        return list;
    }

    function safeMatches(el, selector) {
        try {
            return el.matches(selector);
        } catch (e) {
            return false;
        }
    }

    function pathPart(node) {
        const id = stableId(node);
        if (id) {
            return id;
        }
        let part = SELECTOR_OK.test(node.localName) ? node.localName : '*';
        part += stableClasses(node).slice(0, 2).join('');

        const parent = node.parentElement;
        if (parent) {
            let same = 0;
            let index = 0;
            for (let i = 0; i < parent.children.length; i++) {
                const sibling = parent.children[i];
                if (sibling === node) {
                    index = i + 1;
                }
                if (safeMatches(sibling, part)) {
                    same++;
                }
            }
            if (same > 1) {
                part += ':nth-child(' + index + ')';
            }
        }
        return part;
    }

    /**
     * @param {Element} el
     * @return {string} A unique, server-acceptable selector, or '' if none exists.
     */
    function buildSelector(el) {
        const simple = simpleCandidates(el);
        for (let i = 0; i < simple.length; i++) {
            if (isUnique(simple[i], el)) {
                return simple[i];
            }
        }

        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
            parts.unshift(pathPart(node));
            const candidate = parts.join(' > ');
            if (isUnique(candidate, el)) {
                return candidate;
            }
            if (parts[0].charAt(0) === '#') {
                break;
            }
            node = node.parentElement;
        }
        return '';
    }

    function safeQuery(selector) {
        if (typeof selector !== 'string' || !selector || selector.length > MAX_LEN || !SELECTOR_OK.test(selector)) {
            return [];
        }
        try {
            return Array.prototype.slice.call(document.querySelectorAll(selector));
        } catch (e) {
            return [];
        }
    }

    function describe(el) {
        let text = el.localName;
        if (el.getAttribute('id')) {
            text += '#' + el.getAttribute('id');
        }
        if (el.classList.length) {
            text += '.' + Array.prototype.slice.call(el.classList, 0, 3).join('.');
        }
        return text;
    }

    /* ------------------------------------------------------------------ *
     * Highlight overlay
     * A shadow-DOM overlay instead of an outline on the target element: it
     * never mutates the page's classes/styles (so it cannot disturb selectors
     * or fight GSAP transforms), it can't be clipped by overflow:hidden
     * ancestors, and site CSS cannot restyle it.
     * ------------------------------------------------------------------ */

    let hoverBox, selectBox, label;
    let hoverEl = null;
    let selectedEl = null;
    let rafId = 0;

    function buildOverlay() {
        const host = document.createElement('div');
        host.setAttribute('data-kwipa-overlay', '');
        host.style.cssText = 'all:initial;display:block;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML =
            '<style>' +
            '.box{position:fixed;display:none;box-sizing:border-box;pointer-events:none}' +
            '.hover{outline:2px dashed #2271b1;outline-offset:-1px;background:rgba(34,113,177,.1)}' +
            '.select{outline:2px solid #00a32a;outline-offset:-1px;background:rgba(0,163,42,.1)}' +
            '.label{position:fixed;display:none;font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#fff;background:#2271b1;padding:0 6px;border-radius:2px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;pointer-events:none}' +
            '</style>' +
            '<div class="box hover"></div><div class="box select"></div><div class="label"></div>';

        hoverBox = root.querySelector('.hover');
        selectBox = root.querySelector('.select');
        label = root.querySelector('.label');

        document.documentElement.appendChild(host);
    }

    function place(box, el) {
        if (!el || !el.isConnected) {
            box.style.display = 'none';
            return null;
        }
        const r = el.getBoundingClientRect();
        box.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
        return r;
    }

    function frame() {
        rafId = 0;
        place(selectBox, selectedEl);
        const r = place(hoverBox, hoverEl);

        if (r) {
            const text = describe(hoverEl);
            if (label.textContent !== text) {
                label.textContent = text;
            }
            label.style.cssText = 'display:block;left:' + r.left + 'px;top:' + (r.top > 22 ? r.top - 20 : r.top + 2) + 'px';
        } else {
            label.style.display = 'none';
        }

        if (hoverEl || selectedEl) {
            rafId = requestAnimationFrame(frame);
        }
    }

    function refresh() {
        if (!rafId) {
            rafId = requestAnimationFrame(frame);
        }
    }

    function pickTarget(e) {
        const t = e.target;
        return (t && t.nodeType === 1 && t !== document.documentElement) ? t : null;
    }

    function block(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function select(el) {
        const selector = buildSelector(el);
        if (!selector) {
            fail('selector_unavailable', 'Could not build a safe, unique selector for this element.');
            return;
        }
        selectedEl = el;
        refresh();
        post({
            type: 'select',
            selector,
            tag: el.localName,
            id: el.getAttribute('id') || '',
            classes: Array.prototype.slice.call(el.classList, 0, 20),
            label: describe(el),
        });
    }

    function onClick(e) {
        block(e);
        const el = e.isTrusted ? pickTarget(e) : null;
        if (el) {
            select(el);
        }
    }

    function onOver(e) {
        const el = pickTarget(e);
        if (el !== hoverEl) {
            hoverEl = el;
            refresh();
        }
    }

    function onOut(e) {
        if (!e.relatedTarget) {
            hoverEl = null;
            refresh();
        }
    }


    const registry = new Map();
    let originalStyles = new WeakMap();

    function num(value, fallback, min, max) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
    }

    function propsOf(preset) {
        return Object.keys(preset.from || preset.to || preset.keyframes).filter((k) => k !== 'easeEach').join(',');
    }

    function remember(el) {
        if (!originalStyles.has(el)) {
            originalStyles.set(el, el.getAttribute('style'));
        }
    }

    function restore(el) {
        window.gsap.killTweensOf(el);
        window.gsap.set(el, { clearProps: 'all' });
        if (originalStyles.has(el)) {
            const saved = originalStyles.get(el);
            if (saved === null) {
                el.removeAttribute('style');
            } else {
                el.setAttribute('style', saved);
            }
        }
    }

    function runEntrance(els, preset, duration, delay, extra) {
        const props = propsOf(preset);
        window.gsap.killTweensOf(els, props);
        window.gsap.set(els, { clearProps: props });
        return window.gsap.from(els, Object.assign({}, preset.from, { duration, delay, ease: preset.ease || 'power2.out' }, extra));
    }

    function runEffect(els, preset, duration, delay, extra) {
        const vars = { duration, delay, ease: preset.ease || 'power1.inOut', overwrite: 'auto' };

        if (preset.keyframes) {
            vars.keyframes = preset.keyframes;
            vars.ease = 'none';
        } else {
            Object.assign(vars, preset.to);
            if (preset.legs) {
                vars.duration = duration / preset.legs;
                vars.repeat = preset.legs - 1;
                vars.yoyo = true;
            }
        }
        return window.gsap.to(els, Object.assign(vars, extra));
    }

    function play(els, preset, duration, delay, extra) {
        return preset.kind === 'entrance'
            ? runEntrance(els, preset, duration, delay, extra)
            : runEffect(els, preset, duration, delay, extra);
    }

    function teardown(key) {
        const entry = registry.get(key);
        if (!entry) {
            return;
        }
        entry.listeners.forEach((l) => l.el.removeEventListener(l.type, l.fn));
        entry.triggers.forEach((t) => t.kill());
        entry.tweens.forEach((t) => t.kill());
        entry.calls.forEach((c) => c.kill());
        entry.els.forEach(restore);
        registry.delete(key);
    }

    function clearPreviews(selector) {
        if (!window.gsap) {
            return;
        }
        Array.from(registry.keys()).forEach((key) => {
            if (!selector || key.indexOf(selector + '|') === 0) {
                teardown(key);
            }
        });
        if (!selector) {
            originalStyles = new WeakMap();
        }
    }

    function runPreview(msg) {
        const gsap = window.gsap;
        if (!gsap) {
            fail('gsap_missing', 'GSAP is not loaded in the preview frame.');
            return;
        }

        const settings = (msg.settings && typeof msg.settings === 'object') ? msg.settings : {};
        const name = typeof settings.animation === 'string' ? settings.animation : '';
        const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : null;

        if (TRIGGERS.indexOf(msg.trigger) === -1 || !preset) {
            fail('invalid_preview', 'Unknown trigger or animation preset.');
            return;
        }

        const els = safeQuery(msg.selector);
        if (!els.length) {
            fail('no_match', 'The selector does not match any element on this page.');
            return;
        }

        const duration = num(settings.duration, 1, 0, 30);
        const delay = num(settings.delay, 0, 0, 30);
        const key = msg.selector + '|' + msg.trigger;

        teardown(key);

        const entry = { els, tweens: [], listeners: [], triggers: [], calls: [] };
        registry.set(key, entry);
        els.forEach(remember);

        if (msg.trigger === 'load' || msg.trigger === 'click') {
            entry.tweens.push(play(els, preset, duration, delay));

        } else if (msg.trigger === 'scroll') {
            const ST = window.ScrollTrigger;
            if (!ST) {
                fail('scrolltrigger_missing', 'ScrollTrigger is not loaded; playing the animation immediately instead.');
                entry.tweens.push(play(els, preset, duration, delay));
            } else {
                gsap.registerPlugin(ST);
                els.forEach((el) => {
                    const tween = play(el, preset, duration, delay, { paused: true });
                    entry.tweens.push(tween);
                    entry.triggers.push(ST.create({ trigger: el, start: 'top 85%', once: true, onEnter: () => tween.play() }));
                });
                const r = els[0].getBoundingClientRect();
                if (r.top < 0 || r.bottom > window.innerHeight) {
                    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }

        } else {
            const handlers = els.map((el) => {
                let tween = null;
                let enter;
                let leave = () => { };

                if (preset.kind === 'entrance') {
                    enter = () => {
                        if (!tween || !tween.isActive()) {
                            tween = runEntrance(el, preset, duration, delay);
                        }
                    };
                } else if (preset.hold) {
                    tween = gsap.to(el, Object.assign({}, preset.to, { duration, ease: preset.ease || 'power2.out', paused: true }));
                    enter = () => tween.play();
                    leave = () => tween.reverse();
                } else {
                    enter = () => {
                        if (!tween || !tween.isActive()) {
                            tween = runEffect(el, preset, duration, delay);
                        }
                    };
                }

                el.addEventListener('mouseenter', enter);
                el.addEventListener('mouseleave', leave);
                entry.listeners.push({ el, type: 'mouseenter', fn: enter }, { el, type: 'mouseleave', fn: leave });
                entry.tweens.push({ kill: () => tween && tween.kill() });

                return { enter, leave };
            });

            handlers.forEach((h) => h.enter());
            entry.calls.push(gsap.delayedCall(delay + duration + 0.5, () => handlers.forEach((h) => h.leave())));
        }

        post({ type: 'preview-started', selector: msg.selector, trigger: msg.trigger, matches: els.length });
    }

    function announce() {
        post({ type: 'ready', gsap: !!window.gsap, scrollTrigger: !!window.ScrollTrigger });
    }

    function highlight(selector) {
        const el = selector ? safeQuery(selector)[0] : null;
        selectedEl = el || null;
        refresh();

        if (el) {
            const r = el.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
    }

    function onMessage(e) {
        if (e.source !== window.parent || e.origin !== PARENT_ORIGIN) {
            return;
        }
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || msg.source !== MSG_IN || typeof msg.type !== 'string') {
            return;
        }

        switch (msg.type) {
            case 'ping':
                announce();
                break;
            case 'highlight':
                highlight(msg.selector);
                break;
            case 'preview':
                runPreview(msg);
                break;
            case 'clear':
                clearPreviews(typeof msg.selector === 'string' && msg.selector ? msg.selector : null);
                break;
        }
    }

    // Capture phase on window: runs before the page's own handlers, so links,
    // forms and site UI scripts never fire while the builder is open.
    ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit'].forEach((type) => {
        window.addEventListener(type, type === 'click' ? onClick : block, true);
    });
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', () => clearPreviews(null));

    function init() {
        buildOverlay();
        announce();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());