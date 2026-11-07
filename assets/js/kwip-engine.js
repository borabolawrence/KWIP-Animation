/**
 * KWIP Animation - Frontend engine (vanilla JS, no dependencies besides GSAP).
 *
 * Reads window.KWIPAnimationConfig (printed inline by PHP):
 *   { ".selector": { "load|scroll|hover|click": { animation, duration, delay? } } }
 *
 * Also the single source of truth for what each preset does: the builder's
 * inspector calls window.KWIPAEngine instead of keeping its own copy. When
 * window.KWIPABuilderMode is set (builder iframe only), it exposes the API
 * and does NOT auto-run, because the inspector previews animations itself.
 *
 * Preset semantics:
 *   entrance: animates FROM the given state TO the element's natural state.
 *   effect:   animates from natural TO the given state (legs > 1 = yoyo back).
 *   hold:     on hover, stays in the target state until mouseleave.
 * Slugs must match KWIPA_Config::allowed_animations().
 *
 * ES5 on purpose: this file ships to every visitor, so no build step or polyfills.
 */
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

    var PRESETS = {
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
        'shake': { kind: 'effect', keyframes: { x: [-10, 10, -8, 8, -4, 4, 0], easeEach: 'sine.inOut' } }
    };

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

    /**
     * Validate one trigger's settings (never trust the config blindly, even
     * though PHP sanitized it).
     *
     * @return {{preset:Object,duration:number,delay:number}|null}
     */
    function resolve(settings) {
        if (!settings || typeof settings !== 'object' || typeof settings.animation !== 'string' || !has(PRESETS, settings.animation)) {
            return null;
        }
        return {
            preset: PRESETS[settings.animation],
            duration: num(settings.duration, 1, 0, 30),
            delay: num(settings.delay, 0, 0, 30)
        };
    }

    function entrance(els, preset, duration, delay, extra, replay) {
        if (replay) {
            var props = propsOf(preset);
            gsap.killTweensOf(els, props);
            gsap.set(els, { clearProps: props });
        }
        return gsap.from(els, extend({}, preset.from, { duration: duration, delay: delay, ease: preset.ease || 'power2.out' }, extra));
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

    /**
     * Run a preset once.
     * @param {Element|Element[]} els
     * @param {Object} preset Entry from PRESETS.
     * @param {Object} [extra] Extra GSAP vars (e.g. { paused: true }).
     * @param {boolean} [replay] Reset the entrance state first (hover/click replays).
     */
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
     * Arm a once-only scroll animation for ONE element.
     * Without ScrollTrigger the animation plays immediately rather than never.
     *
     * @return {{tween:Object,trigger:Object|null}}
     */
    function scroll(el, resolved, ST, replay) {
        if (!ST) {
            return { tween: play(el, resolved.preset, resolved.duration, resolved.delay, null, replay), trigger: null };
        }
        var tween = play(el, resolved.preset, resolved.duration, resolved.delay, { paused: true }, replay);
        var trigger = ST.create({
            trigger: el,
            start: 'top 85%',
            once: true,
            onEnter: function () { tween.play(); }
        });
        return { tween: tween, trigger: trigger };
    }

    window.KWIPAEngine = { presets: PRESETS, resolve: resolve, play: play, hover: hover, scroll: scroll };

    if (window.KWIPABuilderMode) {
        return;
    }

    function bindClick(el, resolved) {
        var tween = null;
        el.addEventListener('click', function () {
            if (!tween || !tween.isActive()) {
                tween = play(el, resolved.preset, resolved.duration, resolved.delay, null, true);
            }
        });
    }

    function bindHover(el, resolved) {
        var hv = hover(el, resolved.preset, resolved.duration, resolved.delay);
        el.addEventListener('mouseenter', hv.enter);
        el.addEventListener('mouseleave', hv.leave);
    }

    function run(config) {
        if (!config || typeof config !== 'object') {
            return;
        }
        var ST = window.ScrollTrigger;
        var canHover = !window.matchMedia || window.matchMedia('(hover: hover)').matches;

        Object.keys(config).forEach(function (selector) {
            var triggers = config[selector];
            var els;

            try {
                els = Array.prototype.slice.call(document.querySelectorAll(selector));
            } catch (e) {
                return;
            }
            if (!els.length || !triggers || typeof triggers !== 'object') {
                return;
            }

            var load = resolve(triggers.load);
            var scr = resolve(triggers.scroll);
            var hov = resolve(triggers.hover);
            var clk = resolve(triggers.click);

            if (load) {
                play(els, load.preset, load.duration, load.delay);
            }
            if (scr) {
                els.forEach(function (el) { scroll(el, scr, ST, false); });
            }
            if (hov && canHover) {
                els.forEach(function (el) { bindHover(el, hov); });
            }
            if (clk) {
                els.forEach(function (el) { bindClick(el, clk); });
            }
        });
    }

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    onReady(function () {
        try {
            if (!reduced) {
                run(window.KWIPAnimationConfig);
            }
        } finally {
            reveal();
        }
    });
}(window, document));