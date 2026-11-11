/**
 * KWIP Animation - Motion library screen.
 * React via WordPress core (wp-element), no build step. Loaded only on the
 * "Motion library" admin page; talks to the /motions REST routes.
 */
(function () {
    'use strict';

    const data = window.KWIPAAdminData;
    const mount = document.getElementById('kwipa-root');
    const wpEl = window.wp && window.wp.element;

    if (!data || data.view !== 'library' || !mount || !wpEl) {
        return;
    }

    const h = wpEl.createElement;
    const { Fragment, useState } = wpEl;

    const API = data.rest.restUrl.replace(/\/$/, '');
    const MAX_BYTES = data.limits.maxPackBytes;


    async function request(method, path, body) {
        const res = await fetch(API + path, {
            method,
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-WP-Nonce': data.rest.restNonce,
                'X-KWIPA-Nonce': data.rest.kwipNonce,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        let json = null;
        try {
            json = await res.json();
        } catch (e) {
            json = null;
        }

        if (!res.ok) {
            const expired = json && (json.code === 'kwipa_bad_nonce' || json.code === 'rest_cookie_invalid_nonce');
            throw new Error(expired
                ? 'Your security token expired. Reload this page to continue.'
                : ((json && json.message) || 'Request failed (HTTP ' + res.status + ').'));
        }
        return json;
    }

    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

    function Notice(props) {
        return h('div', { className: 'kwipa-notice is-' + props.type, role: props.type === 'error' ? 'alert' : 'status' },
            h('span', null, props.text),
            h('button', { type: 'button', className: 'kwipa-notice-x', 'aria-label': 'Dismiss', onClick: props.onDismiss }, '\u00d7')
        );
    }

    function MotionTiles(props) {
        return h('ul', { className: 'kwipa-lib-motions' },
            props.motions.map((m) => h('li', { key: m.slug, title: m.group + ': ' + m.slug },
                h('div', { className: 'kwipa-tile kwipa-tile-static', 'data-anim': m.glyph },
                    h('span', { className: 'kwipa-glyph-box', 'aria-hidden': 'true' }, h('i', { className: 'kwipa-glyph' })),
                    h('span', { className: 'kwipa-tile-name' }, m.label)
                )
            ))
        );
    }

    function PackRow(props) {
        const pack = props.pack;
        const [open, setOpen] = useState(false);
        const confirming = props.confirmId === pack.id;
        const extra = pack.used - pack.usages.length;

        return h('li', { className: 'kwipa-pack' },
            h('div', { className: 'kwipa-pack-head' },
                h('div', { className: 'kwipa-pack-title' },
                    h('h3', null, pack.name),
                    h('span', { className: 'kwipa-tag' }, 'v' + pack.version),
                    pack.builtin && h('span', { className: 'kwipa-tag is-builtin' }, 'Built in')
                ),
                h('div', { className: 'kwipa-pack-actions' },
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? 'Hide motions' : 'Show motions'),
                    !pack.builtin && h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', disabled: props.busy, onClick: () => props.onAskRemove(pack.id) }, 'Remove')
                )
            ),
            h('p', { className: 'kwipa-pack-meta' },
                h('span', null, plural(pack.motions.length, 'motion', 'motions')),
                pack.author && h('span', null, 'by ' + pack.author),
                h('span', null, pack.used ? 'Used by ' + plural(pack.used, 'animation', 'animations') : 'Not used yet'),
                h('code', null, pack.id)
            ),
            pack.description && h('p', { className: 'kwipa-pack-desc' }, pack.description),

            confirming && h('div', { className: 'kwipa-confirm', role: 'group', 'aria-label': 'Confirm removal' },
                pack.used
                    ? h(Fragment, null,
                        h('p', null, plural(pack.used, 'animation', 'animations') + ' on your site use motions from this pack. Removing the pack removes them too:'),
                        h('ul', null,
                            pack.usages.map((u, i) => h('li', { key: i }, h('code', null, u.selector), ' (' + u.trigger + ')')),
                            extra > 0 && h('li', { key: 'more' }, 'and ' + extra + ' more')
                        )
                    )
                    : h('p', null, 'Remove "' + pack.name + '"? No animations use it.'),
                h('div', { className: 'kwipa-confirm-actions' },
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-danger', disabled: props.busy, onClick: () => props.onRemove(pack) }, pack.used ? 'Remove pack and animations' : 'Remove pack'),
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-ghost', onClick: props.onCancel }, 'Cancel')
                )
            ),

            open && h(MotionTiles, { motions: pack.motions })
        );
    }

    function App() {
        const [library, setLibrary] = useState(data.library);
        const [notice, setNotice] = useState(null);
        const [busy, setBusy] = useState(false);
        const [over, setOver] = useState(false);
        const [pasteOpen, setPasteOpen] = useState(false);
        const [pasted, setPasted] = useState('');
        const [confirmId, setConfirmId] = useState('');

        async function installPack(pack) {
            setBusy(true);
            setNotice(null);
            try {
                const res = await request('POST', '/motions/install', { pack });
                const base = '"' + res.name + '" ' + (res.replaced ? 'updated.' : 'installed.');
                setLibrary(res.library);

                if (res.orphans && res.orphans.length) {
                    const list = res.orphans.slice(0, 3).map((o) => o.selector + ' (' + o.trigger + ')').join(', ');
                    setNotice({ type: 'warning', text: base + ' ' + plural(res.orphans.length, 'saved animation uses', 'saved animations use') + ' a motion that is no longer in the library: ' + list + (res.orphans.length > 3 ? ' and more' : '') + '.' });
                } else {
                    setNotice({ type: 'success', text: base });
                }
            } catch (err) {
                setNotice({ type: 'error', text: err.message });
            } finally {
                setBusy(false);
            }
        }

        async function handleFile(file) {
            if (!file) {
                return;
            }
            if (file.size > MAX_BYTES) {
                setNotice({ type: 'error', text: 'That file is larger than ' + Math.round(MAX_BYTES / 1024) + ' KB, the limit for a motion pack.' });
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
            } catch (e) {
                setNotice({ type: 'error', text: 'That file is not valid JSON.' });
                return;
            }
            await installPack(parsed);
        }

        async function installPasted() {
            let parsed;
            try {
                parsed = JSON.parse(pasted.replace(/^\uFEFF/, ''));
            } catch (e) {
                setNotice({ type: 'error', text: 'That is not valid JSON.' });
                return;
            }
            await installPack(parsed);
            setPasted('');
        }

        async function removePack(pack) {
            setBusy(true);
            setNotice(null);
            try {
                const res = await request('DELETE', '/motions/' + encodeURIComponent(pack.id), { force: pack.used > 0 });
                setLibrary(res.library);
                setConfirmId('');
                setNotice({ type: 'success', text: '"' + pack.name + '" removed.' + (res.removedAnimations ? ' ' + plural(res.removedAnimations, 'animation that used it was', 'animations that used it were') + ' removed too.' : '') });
            } catch (err) {
                setNotice({ type: 'error', text: err.message });
            } finally {
                setBusy(false);
            }
        }

        const renderPacks = (packs) => h('ul', { className: 'kwipa-packs' }, packs.map((pack) => h(PackRow, {
            key: pack.id,
            pack,
            busy,
            confirmId,
            onAskRemove: setConfirmId,
            onCancel: () => setConfirmId(''),
            onRemove: removePack,
        })));

        return h('div', { className: 'kwipa-lib' },
            h('header', { className: 'kwipa-lib-head' },
                h('h1', null, 'Motion library'),
                h('p', { className: 'kwipa-lead' }, 'Motion packs add animations to the builder. A pack is a single JSON file, and installing one never runs code.'),
                h('a', { className: 'kwipa-more', href: data.builderUrl }, 'Back to the builder')
            ),

            notice && h(Notice, { type: notice.type, text: notice.text, onDismiss: () => setNotice(null) }),

            h('section', { className: 'kwipa-lib-section' },
                h('h2', null, 'Add motions'),
                h('label', {
                    className: 'kwipa-drop' + (over ? ' is-over' : '') + (busy ? ' is-busy' : ''),
                    onDragOver: (e) => { e.preventDefault(); setOver(true); },
                    onDragLeave: () => setOver(false),
                    onDrop: (e) => {
                        e.preventDefault();
                        setOver(false);
                        handleFile(e.dataTransfer.files && e.dataTransfer.files[0]);
                    },
                },
                    h('input', {
                        type: 'file',
                        accept: '.json,application/json',
                        disabled: busy,
                        onChange: (e) => {
                            handleFile(e.target.files && e.target.files[0]);
                            e.target.value = '';
                        },
                    }),
                    h('strong', null, busy ? 'Working\u2026' : 'Choose a pack file'),
                    h('span', null, 'or drop a .json file here')
                ),
                h('button', { type: 'button', className: 'kwipa-link', 'aria-expanded': pasteOpen, onClick: () => setPasteOpen(!pasteOpen) }, pasteOpen ? 'Hide pasted JSON' : 'Paste JSON instead'),
                pasteOpen && h('div', { className: 'kwipa-paste' },
                    h('label', { className: 'screen-reader-text', htmlFor: 'kwipa-paste-box' }, 'Motion pack JSON'),
                    h('textarea', { id: 'kwipa-paste-box', rows: 9, spellCheck: false, value: pasted, placeholder: '{ "schema": 1, "id": "my-pack", ... }', onChange: (e) => setPasted(e.target.value) }),
                    h('button', { type: 'button', className: 'kwipa-btn kwipa-btn-dark', disabled: busy || !pasted.trim(), onClick: installPasted }, 'Install pasted pack')
                )
            ),

            h('section', { className: 'kwipa-lib-section' },
                h('h2', null, 'Installed packs'),
                library.installed.length
                    ? renderPacks(library.installed)
                    : h('p', { className: 'kwipa-hint' }, 'No packs installed yet. Choose a .json file or paste one above to add motions.')
            ),

            h('section', { className: 'kwipa-lib-section' },
                h('h2', null, 'Built in'),
                renderPacks(library.builtin)
            )
        );
    }

    if (wpEl.createRoot) {
        wpEl.createRoot(mount).render(h(App));
    } else {
        wpEl.render(h(App), mount);
    }
}());