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
    const Engine = window.KWIPAEngine;

    const ATTR_TOKEN = /^\[[a-zA-Z][a-zA-Z0-9_-]*(?:[~|^$*]?="[a-zA-Z0-9 _.:-]{1,64}")?\]$/;
    const BASE_SELECTOR_OK = /^[\p{L}\p{N}_\-#.>+~:()*\\\/ ]+$/u;
    const STATE_CLASS = /^(active|current|open|opened|show|shown|hide|hidden|visible|hover|focus|focused|selected|disabled|loading|loaded|ready|animated|in-?view|is-[\w-]+|aos-[\w-]+|kwipa-[\w-]+)$/i;
    const UNSTABLE = /\d{5,}|^(css|sc|jsx|svelte|emotion|styled)-[a-z0-9]+$/i;

    function isSelectorSafe(selector) {
        if (typeof selector !== 'string' || !selector || selector.length > MAX_LEN || selector.indexOf('</') !== -1) {
            return false;
        }
        let invalidAttr = false;
        const stripped = selector.replace(/\[[^\]]*\]/g, (token) => {
            if (!ATTR_TOKEN.test(token)) {
                invalidAttr = true;
            }
            return '__ATTR__';
        });
        if (invalidAttr || stripped.indexOf('[') !== -1 || stripped.indexOf(']') !== -1) {
            return false;
        }
        if (/[>+~\\]$/.test(stripped)) {
            return false;
        }
        return BASE_SELECTOR_OK.test(stripped);
    }

    function post(payload) {
        payload.source = MSG_OUT;
        try {
            window.parent.postMessage(payload, PARENT_ORIGIN);
        } catch (e) {
            // Parent unavailable.
        }
    }

    function fail(code, message) {
        post({ type: 'error', code, message });
    }

    function esc(value) {
        return (window.CSS && CSS.escape) ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
    }

    function isUnique(selector, el) {
        if (!isSelectorSafe(selector)) {
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
        if (!isSelectorSafe(token)) {
            return '';
        }
        try {
            return document.querySelectorAll(token).length === 1 ? token : '';
        } catch (e) {
            return '';
        }
    }

    function stableDataAttrs(el) {
        const out = [];
        Array.prototype.forEach.call(el.attributes, (attr) => {
            if (attr.name.indexOf('data-') !== 0 || /^data-(kwipa|wp-|elementor|vc-|et-)/i.test(attr.name)) {
                return;
            }
            const token = attr.value && /^[a-zA-Z0-9 _.:-]{1,40}$/.test(attr.value)
                ? '[' + attr.name + '="' + attr.value + '"]'
                : '[' + attr.name + ']';
            if (isSelectorSafe(token)) {
                out.push(token);
            }
        });
        return out.slice(0, 3);
    }

    function stableClasses(el) {
        const out = [];
        Array.prototype.forEach.call(el.classList, (name) => {
            if (STATE_CLASS.test(name) || UNSTABLE.test(name)) {
                return;
            }
            const token = '.' + esc(name);
            if (isSelectorSafe(token)) {
                out.push(token);
            }
        });
        return out;
    }

    function simpleCandidates(el) {
        const tag = isSelectorSafe(el.localName) ? el.localName : '';
        const id = stableId(el);
        const attrs = stableDataAttrs(el);
        const classes = stableClasses(el).slice(0, 6);
        const list = [];

        if (id) {
            list.push(id);
        }
        attrs.forEach((a) => list.push(a));
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
        let part = isSelectorSafe(node.localName) ? node.localName : '*';
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
        if (!isSelectorSafe(selector)) {
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
            text += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
        }
        return text;
    }

    function collectAncestors(el) {
        const chain = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && chain.length < 6) {
            const sel = buildSelector(node);
            if (sel) {
                chain.unshift({ selector: sel, label: describe(node) });
            }
            node = node.parentElement;
        }
        return chain;
    }

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
            '.hover{outline:1.5px dashed #38bdf8;outline-offset:-1px;background:rgba(56,189,248,.07)}' +
            '.select{outline:2px solid #88ce02;outline-offset:-1px;background:rgba(136,206,2,.08);box-shadow:0 0 0 1px rgba(9,11,15,.45)}' +
            '.handle{position:absolute;width:6px;height:6px;background:#9ef01a;border:1.5px solid #090b0f;border-radius:1.5px}' +
            '.tl{top:-4px;left:-4px}.tr{top:-4px;right:-4px}.bl{bottom:-4px;left:-4px}.br{bottom:-4px;right:-4px}' +
            '.label{position:fixed;display:none;font:600 11px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#f3f5f8;background:#11141b;border:1px solid rgba(255,255,255,.16);padding:1px 7px;border-radius:5px;box-shadow:0 4px 12px rgba(0,0,0,.45);white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;pointer-events:none}' +
            '</style>' +
            '<div class="box hover"></div>' +
            '<div class="box select"><i class="handle tl"></i><i class="handle tr"></i><i class="handle bl"></i><i class="handle br"></i></div>' +
            '<div class="label"></div>';

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
            const dims = Math.round(r.width) + '\u00d7' + Math.round(r.height);
            const text = describe(hoverEl) + ' \u00b7 ' + dims;
            if (label.textContent !== text) {
                label.textContent = text;
            }
            label.style.cssText = 'display:block;left:' + r.left + 'px;top:' + (r.top > 26 ? r.top - 24 : r.top + 4) + 'px';
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
            ancestors: collectAncestors(el),
            matches: safeQuery(selector).length,
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

    function teardown(key) {
        const entry = registry.get(key);
        if (!entry) {
            return;
        }
        entry.listeners.forEach((l) => l.el.removeEventListener(l.type, l.fn));
        entry.triggers.forEach((t) => t.kill(true));
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
        if (!gsap || !Engine) {
            fail('gsap_missing', 'GSAP or the KWIP engine is not loaded in the preview frame.');
            return;
        }

        const settings = (msg.settings && typeof msg.settings === 'object') ? msg.settings : {};
        const r = Engine.resolve(settings);

        if (TRIGGERS.indexOf(msg.trigger) === -1 || !r) {
            fail('invalid_preview', 'Unknown trigger or animation preset.');
            return;
        }

        const els = safeQuery(msg.selector);
        if (!els.length) {
            fail('no_match', 'The selector does not match any element on this page.');
            return;
        }

        const key = msg.selector + '|' + msg.trigger;
        teardown(key);

        const entry = { els, tweens: [], listeners: [], triggers: [], calls: [] };
        registry.set(key, entry);
        els.forEach(remember);

        const extra = r.stagger > 0 ? { stagger: r.stagger } : null;

        if (msg.trigger === 'load' || msg.trigger === 'click') {
            entry.tweens.push(Engine.play(els, r.preset, r.duration, r.delay, extra, true));

        } else if (msg.trigger === 'scroll') {
            const ST = window.ScrollTrigger;
            if (!ST) {
                fail('scrolltrigger_missing', 'ScrollTrigger is not loaded; playing the animation immediately instead.');
            }
            const showMarkers = !!(settings.scroll && settings.scroll.markers);
            if (r.stagger > 0 && els.length > 1 && !r.scroll.pin) {
                const armed = Engine.scroll(els, r, ST, true, showMarkers);
                entry.tweens.push(armed.tween);
                if (armed.trigger) {
                    entry.triggers.push(armed.trigger);
                }
            } else {
                els.forEach((el) => {
                    const armed = Engine.scroll(el, r, ST, true, showMarkers);
                    entry.tweens.push(armed.tween);
                    if (armed.trigger) {
                        entry.triggers.push(armed.trigger);
                    }
                });
            }
            if (ST) {
                const rect = els[0].getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > window.innerHeight) {
                    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }

        } else {
            const handlers = els.map((el) => {
                const hv = Engine.hover(el, r.preset, r.duration, r.delay);
                el.addEventListener('mouseenter', hv.enter);
                el.addEventListener('mouseleave', hv.leave);
                entry.listeners.push({ el, type: 'mouseenter', fn: hv.enter }, { el, type: 'mouseleave', fn: hv.leave });
                entry.tweens.push({ kill: hv.kill });
                return hv;
            });

            handlers.forEach((hv) => hv.enter());
            entry.calls.push(gsap.delayedCall(r.delay + r.duration + 0.5, () => handlers.forEach((hv) => hv.leave())));
        }

        post({ type: 'preview-started', selector: msg.selector, trigger: msg.trigger, matches: els.length });
    }

    function announce() {
        post({ type: 'ready', gsap: !!(window.gsap && Engine), scrollTrigger: !!window.ScrollTrigger });
    }

    function highlight(selector) {
        const matches = selector ? safeQuery(selector) : [];
        const el = matches[0] || null;
        selectedEl = el;
        refresh();

        if (selector) {
            post({ type: 'matched', selector, matches: matches.length });
        }

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