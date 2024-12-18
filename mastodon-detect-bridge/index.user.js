// ==UserScript==
// @name        Mastodon - Open bsky.app links via Bridgy Fed
// @namespace   https://github.com/tesaguri
// @grant       GM.getValue
// @grant       GM_addValueChangeListener
// @version     1.0.0
// @updateURL   https://github.com/tesaguri/userscripts/raw/main/mastodon-detect-bridge/index.user.js
// @author      Daiki "tesaguri" Mizukami
// @license     GPL-3.0-only; https://www.gnu.org/licenses/gpl-3.0.txt
// @description Open bsky.app links via Bridgy Fed (or optionally via corresponding PDS)
// ==/UserScript==

/**
 * Optional configurations to be stored in the script storage.
 * @typedef {object} Config
 * @property {AtprotoConfig} [atproto]
 */
/**
 * Configurations specific to AT Protocol.
 * @typedef {object} AtprotoConfig
 * @property {AtprotoFallbackBehavior} [fallbackBehavior]
 */
/**
 * Fallback behavior when an atproto resource isn't bridged via Bridgy Fed.
 * - `openPds` - Open the resource via its corresponding PDS endpoint.
 * - `default` - Open the original AppView URL.
 * @typedef {'openPds' | 'default'} AtprotoFallbackBehavior
 */

/**
 * @template T
 * @typedef {(T | null)[] | T?} LdOptional
 */
/**
 * @template T
 * @typedef {[...(T | null)[], T, ...(T | null)[]] | T} LdRequired
 */
/**
 * @typedef {string | { '@id': string } | { id: string }} LdId
 * @typedef {{ '@type': string[] | string } | { type: string[] | string }} HasLdType // `@type` cannot have `null`.
 * @typedef {`did:${string}`} DidString
 * @typedef {HasLdType & { serviceEndpoint: LdRequired<LdId> }} Service
 * @typedef {LdId & { service?: LdOptional<Service> }} DidDocument
 */

(() => {
    // INIT

    addEventListener('click', clickEventListener);
    const acceptAs2Headers = new Headers([
        ['accept', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'],
    ]);
    /**
     * @param {MouseEvent} e
     * @returns {void}
     */
    function clickEventListener(e) {
        if (
            !(e.target instanceof HTMLAnchorElement)
            || !e.target.classList.contains('unhandled-link')
            || !e.target.href.startsWith('https://bsky.app/profile/')
            || e.target.classList.contains('status-url-link')
        ) {
            return;
        }

        const components = atprotoComponentsFromBskyUrl(e.target.href);
        if (!components) {
            return;
        }

        // XXX: We've checked that `e.target` is an `HTMLAnchorElement`, but still need to convince
        // `tsc`.
        /** @type {typeof e & { readonly target: HTMLAnchorElement }} */
        const event = /** @type {any} */ (e);

        const authority = components[0];
        const collection = components[1];
        const rkey = components[2];
        if (collection === undefined || collection === 'app.bsky.feed.post') {
            // Speculatively preventing the default action because `preventDefault` would have no
            // effect in the async callback called after checking the bridge status.
            // Instead, we'll retry the click event in the fallback procedure where appropriate.
            e.preventDefault();

            checkBridge(authority)
                .then(async isBridged => {
                    if (isBridged) {
                        submitSearch(bridgeUrlFromAtprotoComponents(authority, collection, rkey));
                        return;
                    }
                    await atprotoFallback(event, authority, collection, rkey);
                });
        } else {
            atprotoFallback(event, authority, collection, rkey);
        }
    }

    /** @type {Config} */
    let config = Object.create(null);
    const initFallbackBehavior = GM.getValue('fallbackBehavior').then(setFallbackBehavior);
    GM_addValueChangeListener('fallbackBehavior', (_name, _oldValue, value) => {
        setFallbackBehavior(value);
    });

    // UTILITIES - Generic

    /**
     * @param {unknown} value
     * @returns {void}
     */
    function setFallbackBehavior(value) {
        if (typeof value === 'object' && value) {
            /** @type {AtprotoConfig} */
            config.atproto = config.atproto || Object.create(null);
            if ('fallbackBehavior' in value) {
                if (typeof value.fallbackBehavior !== 'string') {
                    console.warn(`${GM.info.script.name}: \`config.fallbackBehavior.atproto\` must be a string`);
                    delete config.atproto.fallbackBehavior;
                } else if (value.fallbackBehavior !== 'openPds' && value.fallbackBehavior !== 'default') {
                    console.warn(`${GM.info.script.name}: unknown value for \`config.atproto.fallbackBehavior\`: ${value.fallbackBehavior}`);
                    delete config.atproto.fallbackBehavior;
                } else {
                    config.atproto.fallbackBehavior = value.fallbackBehavior;
                }
            }
        } else {
            console.warn(`${GM.info.script.name}: \`config.fallbackBehavior\` must be an object`);
            delete config.atproto;
        }
    }

    /**
     * @param {string | URL} [url]
     * @param {string} [target]
     * @param {string} [windowFeatures]
     * @returns {ReturnType<typeof open>}
     */
    function safeOpen(url, target, windowFeatures) {
        const defaultWindowFeatures = 'noreferrer';
        return open(url, target, windowFeatures ? `${defaultWindowFeatures},${windowFeatures}` : defaultWindowFeatures);
    }

    // UTILITIES - Mastodon

    /**
     * @param {string} query
     * @returns {void}
     */
    function submitSearch(query) {
        /** @type {HTMLInputElement | null} */
        const input = document.querySelector('input.search__input');
        if (!input) {
            return;
        }

        input.focus();

        // <https://hustle.bizongo.in/simulate-react-on-change-on-controlled-components-baa336920e04>
        const valueProperty =
            /** @type {NonNullable<ReturnType<typeof Object.getOwnPropertyDescriptor>>} */
            (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'));
        const setValue =
            /** @type {NonNullable<typeof valueProperty.set>} */
            (valueProperty.set);
        setValue.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }

    // UTILITIES - DID/JSON-LD

    /**
     * @param {string} s
     * @returns {s is DidString}
     */
    function isDidString(s) {
        return s.startsWith('did:');
    }

    const acceptDidHeaders = new Headers([['accept', 'application/did+ld+json']]);
    /**
     * @param {DidString} did
     * @returns {Promise<DidDocument>}
     */
    async function resolveDid(did) {
        let url;
        if (did.startsWith('did:plc:')) {
            url = `https://plc.directory/${did}`;
        } else if (did.startsWith('did:web:')) {
            url = `https://${did.slice(8)}/.well-known/did.json`;
        } else {
            throw new Error(`Unrecognized DID: ${did}`);
        }

        const res = await fetch(url, {
            headers: acceptDidHeaders,
            referrer: '',
        });

        if (!res.ok) {
            throw new Error(`Encountered HTTP ${res.status} status while resolving DID ${did}`);
        }

        const ret = await res.json();
        assertIsDidDocument(ret);
        return ret;
    }

    /**
     * @param {any} x
     * @returns {asserts x is LdId}
     */
    function assertIsLdId(x) {
        if (typeof x !== 'string' && (
            ('@id' in x && typeof x['@id'] !== 'string')
            || ('id' in x && typeof x.id !== 'string')
        )) {
            throw TypeError('Argument is not an `@id`');
        }
    }

    /**
     * @param {any} x
     * @returns {asserts x is HasLdType}
     */
    function assertHasLdType(x) {
        if (
            ('@type' in x && !isLdTypeValue(x['@type']))
            || ('type' in x && !isLdTypeValue(x.type))
        ) {
            throw TypeError('@type must be a string or an array of strings');
        }
    }

    /**
     * @param {any} t
     * @returns {t is string[] | string}
     */
    function isLdTypeValue(t) {
        if (Array.isArray(t)) {
            return t.every(x => typeof x === 'string');
        } else {
            return typeof t === 'string';
        }
    }

    /**
     * @param {any} x
     * @returns {asserts x is DidDocument}
     */
    function assertIsDidDocument(x) {
        assertIsLdId(x);
        // @ts-expect-error // implicitly asserting that `x` is an object.
        'service' in x
            && (x.service === null || asArray(x.service).forEach(assertIsService));
    }

    /**
     * @param {any} x
     * @returns {asserts x is Service}
     */
    function assertIsService(x) {
        assertHasLdType(x);
        if ('serviceEndpoint' in x) {
            for (const serviceEndpoint of asArray(x.serviceEndpoint)) {
                assertIsLdId(serviceEndpoint);
            }
        }
    }

    /**
     * @param {LdId} node
     * @returns {string}
     */
    function ldIdOf(node) {
        if (typeof node === 'string') {
            return node;
        } else if ('@id' in node) {
            return node['@id'];
        } else {
            return node.id;
        }
    }

    /**
     * @param {HasLdType} node
     * @returns {string[]}
     */
    function ldTypeOf(node) {
        if ('@type' in node) {
            return asArray(node['@type']);
        } else {
            return asArray(node.type);
        }
    }

    /**
     * @template T
     * @overload
     * @param {LdRequired<T>} value
     * @returns {T[]}
     */
    /**
     * @template T
     * @param {LdOptional<T> | undefined} value
     * @returns {(T | null)[]}
     */
    /**
     * @template T
     * @param {LdOptional<T> | undefined} value
     * @returns {(T | null)[]}
     */
    function asArray(value) {
        if (Array.isArray(value)) {
            return value;
        } else if (value === null || value === undefined) {
            return [];
        } else {
            return [value];
        }
    }

    /**
     * @template T
     * @overload
     * @param {LdRequired<T>} set
     * @returns {T}
     */
    /**
     * @template T
     * @overload
     * @param {LdOptional<T> | undefined} set
     * @returns {(T | undefined)?}
     */
    /**
     * @template T
     * @param {LdOptional<T> | undefined} set
     * @returns {(T | undefined)?}
     */
    function firstOfSet(set) {
        if (Array.isArray(set)) {
            return set.find(x => x !== null);
        } else {
            return set;
        }
    }

    // UTILITIES - AT Protocol

    /**
     * @overload
     * @param {Event & { readonly target: HTMLAnchorElement }} event
     * @param {string} authority
     * @returns {Promise<void>}
     */
    /**
     * @overload
     * @param {Event & { readonly target: HTMLAnchorElement }} event
     * @param {string} authority
     * @param {string | undefined} collection
     * @param {string | undefined} rkey
     * @returns {Promise<void>}
     */
    /**
     * @param {Event & { readonly target: HTMLAnchorElement }} event
     * @param {string} authority
     * @param {string} [collection]
     * @param {string} [rkey]
     * @returns {Promise<void>}
     */
    async function atprotoFallback(event, authority, collection, rkey) {
        await initFallbackBehavior;
        switch (config.atproto?.fallbackBehavior) {
            case 'openPds':
                event.preventDefault();
                safeOpen(await pdsXrpcUrlForComponents(authority, collection, rkey));
                break;
            default:
                if (event.defaultPrevented) {
                    try {
                        removeEventListener('click', clickEventListener);
                        // Using `click()` because `event.target.dispatchEvent(event)` won't open the link.
                        event.target.click();
                    } finally {
                        addEventListener('click', clickEventListener);
                    }
                }
        }
    }

    const acceptDnsJsonHeaders = new Headers([['accept', 'application/dns-json']]);
    /** @type {Record<string, DidString>} */
    const resolvedHandles = Object.create(null);
    /**
     * @param {string} handle
     * @returns {Promise<DidString | void>}
     */
    async function resolveAtprotoHandle(handle) {
        handle = handle.toLowerCase();
        if (handle in resolvedHandles) {
            return resolvedHandles[handle];
        }
        const ret = await resolveAtprotoHandleInner(handle);
        if (ret) {
            resolvedHandles[handle] = ret;
            return ret;
        }
    }

    /**
     * @param {string} handle
     * @returns {Promise<DidString | void>}
     */
    async function resolveAtprotoHandleInner(handle) {
        try {
            const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`, {
                headers: acceptDnsJsonHeaders,
                referrer: '',
            });
            if (res.ok) {
                // We are intentionally loose about the `any` type here because a `TypeError` would
                // be caught by the `try` block just fine.
                const answers = /** @type {any} */ (await res.json()).Answer;
                if (Array.isArray(answers)) {
                    const expectedName = `_atproto.${handle}`;
                    for (const answer of answers) {
                        /** @type {any} */
                        const ans = answer;
                        if (
                            ans.name === expectedName
                            && ans.type === 16
                            && ans.data?.startsWith('"did=did:')
                            && ans.data.endsWith('"')
                        ) {
                            return ans.data.slice(5, -1);
                        }
                    }
                }
            }
        } catch {
            // Fall back on well-known
        }
        try {
            const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
                referrer: '',
            });
            if (res.ok) {
                const body = (await res.text()).trim();
                if (isDidString(body)) {
                    return body;
                }
            }
        } catch {
            // noop
        }
    }

    /**
     * @param {DidDocument} doc
     * @returns {string | void}
     */
    function pdsFromDidDoc(doc) {
        const service = asArray(doc.service)
            .find(service => !!service && ldTypeOf(service).includes('AtprotoPersonalDataServer'));
        if (service) {
            return ldIdOf(firstOfSet(service.serviceEndpoint));
        }
    }

    /**
     * @overload
     * @param {string} authority
     * @returns {Promise<string>}
     */
    /**
     * @overload
     * @param {string} authority
     * @param {string | undefined} collection
     * @param {string | undefined} rkey
     * @returns {Promise<string>}
     */
    /**
     * @param {string} authority
     * @param {string} [collection]
     * @param {string} [rkey]
     * @returns {Promise<string>}
     */
    async function pdsXrpcUrlForComponents(authority, collection, rkey) {
        let did;
        if (isDidString(authority)) {
            did = authority;
        } else {
            did = await resolveAtprotoHandle(authority);
            if (!did) {
                throw Error(`Unable to resolve handle at://${authority}`);
            }
        }

        const pds = pdsFromDidDoc(await resolveDid(did));
        if (rkey === undefined) {
            return `${pds}/xrpc/com.atproto.repo.describeRepo?repo=${did}`;
        } else {
            return `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`;
        }
    }

    // UTILITIES - Bridgy Fed

    /**
     * @overload
     * @param {string} authority
     * @returns {string}
     */
    /**
     * @overload
     * @param {string} authority
     * @param {string | undefined} collection
     * @param {string | undefined} rkey
     * @returns {string}
     */
    /**
     * @param {string} authority
     * @param {string} [collection]
     * @param {string} [rkey]
     * @returns {string}
     */
    function bridgeUrlFromAtprotoComponents(authority, collection, rkey) {
        if (rkey === undefined) {
            return `https://bsky.brid.gy/ap/${authority}`;
        } else {
            return `https://bsky.brid.gy/convert/ap/at://${authority}/${collection}/${rkey}`;
        }

    }

    /** @type {Set<string>} */
    const bridgedAuthorities = new Set();
    /**
     * @param {string} authority
     * @returns {Promise<boolean>}
     */
    async function checkBridge(authority) {
        return bridgedAuthorities.has(authority)
            || (
                authority in resolvedHandles
                && bridgedAuthorities.has(/** @type {string} */(resolvedHandles[authority]))
            )
            || fetch(bridgeUrlFromAtprotoComponents(authority), {
                method: 'HEAD',
                headers: acceptAs2Headers,
                referrer: '',
            })
                .then(res => {
                    if (res.ok) {
                        bridgedAuthorities.add(authority);
                        return true;
                    }
                    return false;
                });
    }

    // UTILITIES - Bluesky

    /**
     * @param {string} url
     * @returns {[string] | [string, string, string] | void}
     */
    function atprotoComponentsFromBskyUrl(url) {
        const segments = url.split('/');
        const authority = segments[4];
        if (authority === undefined) {
            return;
        }
        const collection = segments[5];
        if (collection === undefined) {
            return [authority];
        }
        const rkey = segments[6];
        if (rkey !== undefined) {
            switch (collection) {
                case 'post':
                    return [authority, 'app.bsky.feed.post', rkey];
                case 'feed':
                    return [authority, 'app.bsky.feed.generator', rkey];
            }
        }
    }
})();
