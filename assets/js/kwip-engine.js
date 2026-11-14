(function (window, document) {
    'use strict';

    var has = function (obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    };

    function reveal() {
        var style = document.getElementById('kwipa-prehide');
        if (style && style.parentNode) {
            style.parentNode.removeChild(style);
        }
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    var gsap = window.gsap;

    if (!gsap) {
        onReady(reveal);
        return;
    }
    if (window.ScrollTrigger) {
        gsap.registerPlugin(window.ScrollTrigger);
    }

    var MOTIONS = window.KWIPAMotions && typeof window.KWIPAMotions === 'object' ? window.KWIPAMotions : {};
    var TOKEN = /^(-?)\$([a-z][a-z0-9_]*)$/;
    var EASE_OK = /^(none|linear|(power[1-4]|sine|expo|circ|back|elastic|bounce)\.(in|out|inOut)(\(\s*\d{1,3}(\.\d{1,3})?(\s*,\s*\d{1,3}(\.\d{1,3})?)?\s*\))?|steps\(\s*\d{1,3}\s*\))$/;
    var MEDIA_QUERIES = {
        desktop: '(min-width: 1025px)',
        'not-mobile': '(min-width: 768px)',
        tablet: '(min-width: 768px) and (max-width: 1024px)',
        mobile: '(max-width: 767px)'
    };

    function bind(value, def, overrides) {
        var m = typeof value === 'string' ? TOKEN.exec(value) : null;
        if (!m) {
            return value;
        }
        var spec = def.params && has(def.params, m[2]) ? def.params[m[2]] : null;
        if (!spec) {
            return 0;
        }
        var raw = overrides && typeof overrides === 'object' && has(overrides, m[2]) ? overrides[m[2]] : spec.default;
        var n = num(raw, spec.default, spec.min, spec.max);
        return m[1] ? -n : n;
    }

    function bindProps(props, def, overrides) {
        var out = {};
        for (var key in props) {
            if (has(props, key)) {
                out[key] = Array.isArray(props[key])
                    ? props[key].map(function (v) { return bind(v, def, overrides); })
                    : bind(props[key], def, overrides);
            }
        }
        return out;
    }

    function compile(def, overrides) {
        var preset = { kind: def.kind, ease: def.ease, legs: def.legs, hold: def.hold };
        if (def.from) { preset.from = bindProps(def.from, def, overrides); }
        if (def.to) { preset.to = bindProps(def.to, def, overrides); }
        if (def.keyframes) { preset.keyframes = bindProps(def.keyframes, def, overrides); }
        return preset;
    }

    function extend(target) {
        for (var i = 1; i < arguments.length; i++) {
            var src = arguments[i];
            if (src) {
                for (var key in src) {
                    if (has(src, key)) {
                        target[key] = src[key];
                    }
                }
            }
        }
        return target;
    }

    function num(value, fallback, min, max) {
        var n = Number(value);
        return isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
    }

    function propsOf(preset) {
        return Object.keys(preset.from || preset.to || preset.keyframes).filter(function (k) {
            return k !== 'easeEach';
        }).join(',');
    }

    function resolveScroll(raw) {
        var s = raw && typeof raw === 'object' ? raw : {};
        var scrub = false;
        if (s.scrub === true) {
            scrub = true;
        } else if (typeof s.scrub === 'number' && isFinite(s.scrub) && s.scrub > 0) {
            scrub = Math.min(s.scrub, 10);
        }
        return {
            start: typeof s.start === 'string' && s.start ? s.start : 'top 85%',
            end: typeof s.end === 'string' && s.end ? s.end : 'bottom 20%',
            scrub: scrub,
            pin: s.pin === true,
            toggleActions: typeof s.toggleActions === 'string' && s.toggleActions ? s.toggleActions : 'play none none none',
            trigger: typeof s.trigger === 'string' && s.trigger ? s.trigger : ''
        };
    }

    /**
     * @return {{preset:Object,duration:number,delay:number,stagger:number,breakpoint:string,scroll:Object}|null}
     */
    function resolve(settings) {
        if (!settings || typeof settings !== 'object' || typeof settings.animation !== 'string' || !has(MOTIONS, settings.animation)) {
            return null;
        }
        var preset = compile(MOTIONS[settings.animation], settings.params);
        if (typeof settings.ease === 'string' && EASE_OK.test(settings.ease)) {
            preset.ease = settings.ease;
        }
        var bp = typeof settings.breakpoint === 'string' && has(MEDIA_QUERIES, settings.breakpoint) ? settings.breakpoint : 'all';
        return {
            preset: preset,
            duration: num(settings.duration, 1, 0, 30),
            delay: num(settings.delay, 0, 0, 30),
            stagger: num(settings.stagger, 0, 0, 5),
            breakpoint: bp,
            scroll: resolveScroll(settings.scroll)
        };
    }

    function entrance(els, preset, duration, delay, extra, replay) {
        if (replay) {
            var props = propsOf(preset);
            gsap.killTweensOf(els, props);
            gsap.set(els, { clearProps: props });
        }
        var timing = extend({ duration: duration, delay: delay, ease: preset.ease || 'power2.out' }, extra);

        if (preset.to) {
            return gsap.fromTo(els, extend({}, preset.from), extend({}, preset.to, timing));
        }
        return gsap.from(els, extend({}, preset.from, timing));
    }

    function effect(els, preset, duration, delay, extra) {
        var vars = { duration: duration, delay: delay, ease: preset.ease || 'power1.inOut', overwrite: 'auto' };

        if (preset.keyframes) {
            vars.keyframes = preset.keyframes;
            vars.ease = 'none';
        } else {
            extend(vars, preset.to);
            if (preset.legs) {
                vars.duration = duration / preset.legs;
                vars.repeat = preset.legs - 1;
                vars.yoyo = true;
            }
        }
        return gsap.to(els, extend(vars, extra));
    }

    function play(els, preset, duration, delay, extra, replay) {
        return preset.kind === 'entrance'
            ? entrance(els, preset, duration, delay, extra, replay)
            : effect(els, preset, duration, delay, extra);
    }

    function hover(el, preset, duration, delay) {
        var tween = null;
        var api = {
            enter: null,
            leave: function () { },
            kill: function () {
                if (tween) {
                    tween.kill();
                }
            }
        };

        if (preset.kind === 'entrance') {
            api.enter = function () {
                if (!tween || !tween.isActive()) {
                    tween = play(el, preset, duration, delay, null, true);
                }
            };
        } else if (preset.hold) {
            tween = gsap.to(el, extend({}, preset.to, { duration: duration, ease: preset.ease || 'power2.out', paused: true }));
            api.enter = function () { tween.play(); };
            api.leave = function () { tween.reverse(); };
        } else {
            api.enter = function () {
                if (!tween || !tween.isActive()) {
                    tween = play(el, preset, duration, delay);
                }
            };
        }
        return api;
    }

    /**
     * Arm a ScrollTrigger animation (once, toggleActions, scrub parallax, or pin).
     *
     * @return {{tween:Object,trigger:Object|null}}
     */
    function scroll(target, resolved, ST, replay, previewMarkers) {
        var sc = resolved.scroll || resolveScroll(null);
        var extra = resolved.stagger > 0 ? { stagger: resolved.stagger } : null;
        var defaultEl = Array.isArray(target) ? target[0] : target;
        var triggerEl = defaultEl;

        if (sc.trigger) {
            try {
                var custom = document.querySelector(sc.trigger);
                if (custom) {
                    triggerEl = custom;
                }
            } catch (e) {
                // Keep default trigger element.
            }
        }

        if (!ST) {
            return { tween: play(target, resolved.preset, resolved.duration, resolved.delay, extra, replay), trigger: null };
        }

        var stVars = {
            trigger: triggerEl,
            start: sc.start,
            end: sc.end,
            pin: sc.pin,
            markers: !!previewMarkers
        };

        if (sc.scrub !== false) {
            if (resolved.preset.ease === undefined && resolved.preset.kind === 'entrance') {
                resolved.preset.ease = 'none';
            }
            stVars.scrub = sc.scrub;
            var scrubTween = play(target, resolved.preset, resolved.duration, 0, extend({ scrollTrigger: stVars }, extra), replay);
            return { tween: scrubTween, trigger: scrubTween.scrollTrigger || null };
        }

        var tween = play(target, resolved.preset, resolved.duration, resolved.delay, extend({ paused: true }, extra), replay);
        var isOnce = sc.toggleActions === 'play none none none' && !sc.pin;

        if (isOnce) {
            stVars.once = true;
            stVars.onEnter = function () { tween.play(); };
        } else {
            stVars.toggleActions = sc.toggleActions;
            stVars.animation = tween;
        }

        var trigger = ST.create(stVars);
        return { tween: tween, trigger: trigger };
    }

    function bindClick(el, resolved) {
        var tween = null;
        var handler = function () {
            if (!tween || !tween.isActive()) {
                tween = play(el, resolved.preset, resolved.duration, resolved.delay, null, true);
            }
        };
        el.addEventListener('click', handler);
        return function () {
            el.removeEventListener('click', handler);
            if (tween) { tween.kill(); }
        };
    }

    function bindHover(el, resolved) {
        var hv = hover(el, resolved.preset, resolved.duration, resolved.delay);
        el.addEventListener('mouseenter', hv.enter);
        el.addEventListener('mouseleave', hv.leave);
        return function () {
            el.removeEventListener('mouseenter', hv.enter);
            el.removeEventListener('mouseleave', hv.leave);
            hv.kill();
        };
    }

    function queryUnbound(root, selector, triggerName) {
        var found;
        try {
            found = Array.prototype.slice.call(root.querySelectorAll(selector));
        } catch (e) {
            return [];
        }
        var attr = 'data-kwipa-' + triggerName;
        return found.filter(function (el) {
            if (el.getAttribute(attr) === '1') {
                return false;
            }
            el.setAttribute(attr, '1');
            return true;
        });
    }

    function applyRule(root, selector, triggerName, resolved, ST, canHover) {
        var els = queryUnbound(root, selector, triggerName);
        if (!els.length) {
            return null;
        }

        if (triggerName === 'load') {
            var loadTween = play(els, resolved.preset, resolved.duration, resolved.delay, resolved.stagger > 0 ? { stagger: resolved.stagger } : null);
            return function () { loadTween.kill(); };
        }

        if (triggerName === 'scroll') {
            var armedList = [];
            if ((resolved.stagger > 0 || resolved.scroll.pin) && els.length > 1 && !resolved.scroll.pin) {
                armedList.push(scroll(els, resolved, ST, false, false));
            } else {
                els.forEach(function (el) {
                    armedList.push(scroll(el, resolved, ST, false, false));
                });
            }
            return function () {
                armedList.forEach(function (item) {
                    if (item.trigger) { item.trigger.kill(true); }
                    if (item.tween) { item.tween.kill(); }
                });
            };
        }

        if (triggerName === 'hover' && canHover) {
            var cleanHovers = els.map(function (el) { return bindHover(el, resolved); });
            return function () { cleanHovers.forEach(function (fn) { fn(); }); };
        }

        if (triggerName === 'click') {
            var cleanClicks = els.map(function (el) { return bindClick(el, resolved); });
            return function () { cleanClicks.forEach(function (fn) { fn(); }); };
        }

        return null;
    }

    function run(config, root) {
        if (!config || typeof config !== 'object') {
            return;
        }
        var scopeRoot = root && root.querySelectorAll ? root : document;
        var ST = window.ScrollTrigger;
        var canHover = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
        var mm = gsap.matchMedia ? gsap.matchMedia() : null;

        Object.keys(config).forEach(function (selector) {
            var triggers = config[selector];
            if (!triggers || typeof triggers !== 'object') {
                return;
            }

            ['load', 'scroll', 'hover', 'click'].forEach(function (trigName) {
                var resolved = resolve(triggers[trigName]);
                if (!resolved) {
                    return;
                }

                var query = resolved.breakpoint !== 'all' ? MEDIA_QUERIES[resolved.breakpoint] : '';
                if (mm && query) {
                    mm.add(query, function () {
                        var cleanup = applyRule(scopeRoot, selector, trigName, resolved, ST, canHover);
                        return function () {
                            if (cleanup) { cleanup(); }
                        };
                    });
                } else {
                    applyRule(scopeRoot, selector, trigName, resolved, ST, canHover);
                }
            });
        });

        if (ST && ST.refresh) {
            ST.refresh();
        }
    }

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function refresh(root) {
        if (!reduced && !window.KWIPABuilderMode) {
            run(window.KWIPAnimationConfig, root || document);
        }
    }

    window.KWIPAEngine = {
        motions: MOTIONS,
        resolve: resolve,
        play: play,
        hover: hover,
        scroll: scroll,
        refresh: refresh
    };

    if (window.KWIPABuilderMode) {
        return;
    }

    onReady(function () {
        try {
            if (!reduced) {
                run(window.KWIPAnimationConfig, document);
            }
        } finally {
            reveal();
        }
    });
}(window, document));