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

        const atUri = AtUri.fromBskyUrl(e.target.href);
        if (!atUri) {
            return;
        }

        // XXX: We've checked that `e.target` is an `HTMLAnchorElement`, but still need to convince
        // `tsc`.
        /** @type {typeof e & { readonly target: HTMLAnchorElement }} */
        const event = /** @type {any} */ (e);

        if (!('collection' in atUri) || atUri.collection === 'app.bsky.feed.post') {
            // Speculatively preventing the default action because `preventDefault` would have no
            // effect in the async callback called after checking the bridge status.
            // Instead, we'll retry the click event in the fallback procedure where appropriate.
            e.preventDefault();

            checkBridge(atUri)
                .then(async isBridged => {
                    if (isBridged) {
                        submitSearch(bridgeUrlFromAtUri(atUri));
                        return;
                    }
                    await atprotoFallback(event, atUri);
                });
        } else {
            atprotoFallback(event, atUri);
        }
    }

    /** @type {Config} */
    let config = Object.create(null);
    const initFallbackBehavior = GM.getValue('atproto').then(setAtprotoConfig);
    GM_addValueChangeListener('atproto', (_name, _oldValue, value) => {
        setAtprotoConfig(value);
    });

    // UTILITIES - Generic

    /**
     * @param {unknown} value
     * @returns {void}
     */
    function setAtprotoConfig(value) {
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

    class AtUri {
        /**
         * @typedef {{ authority: string, collection?: string } | { authority: string, collection: string, rkey?: string }} AtUriComponents
         * @typedef {{ authority: string }} AtUriAuthority
         * @typedef {AtUriAuthority & { collection: string }} AtUriCollection
         * @typedef {AtUriCollection & { rkey: string }} AtUriRecord
         * @typedef {AtUri & { components: AtUriComponents & { authority: DidString } }} AtUriWithDid
         */

        /** @type {AtUriComponents} */
        components;

        /**
         * @overload
         * @param {string} authority
         */
        /**
         * @overload
         * @param {string} authority
         * @param {string} collection
         */
        /**
         * @overload
         * @param {string} authority
         * @param {string} collection
         * @param {string} rkey
         */
        /**
         * @overload
         * @param {AtUriComponents} components
         */
        /**
         * @param {string | AtUriComponents} authorityOrComponents
         * @param {string} [collection]
         * @param {string} [rkey]
         */
        constructor(authorityOrComponents, collection, rkey) {
            if (typeof authorityOrComponents === 'object') {
                this.components = authorityOrComponents;
            } else {
                /** @type {Partial<AtUriRecord> & AtUriAuthority} */
                const components = { authority: authorityOrComponents };
                if (collection !== undefined) {
                    components.collection = collection;
                    if (rkey !== undefined) {
                        components.rkey = rkey;
                    }
                }
                this.components = components;
            }
        }

        /**
         * @param {string} url
         * @returns {AtUri | void}
         */
        static fromBskyUrl(url) {
            const segments = url.split('/');
            const authority = segments[4];
            if (authority === undefined) {
                return;
            }
            const bskyCollection = segments[5];
            if (bskyCollection === undefined) {
                return new this(authority);
            }
            const rkey = segments[6];
            let collection;
            if (rkey !== undefined) {
                switch (bskyCollection) {
                    case 'post':
                        collection = 'app.bsky.feed.post';
                        break;
                    case 'feed':
                        collection = 'app.bsky.feed.generator';
                        break;
                }
            }
            if (collection !== undefined) {
                if (rkey !== undefined) {
                    return new this(authority, collection, rkey);
                }
                return new this(authority, collection);
            }
        }

        /** @returns {typeof this.components.authority} */
        get authority() {
            return this.components.authority;
        }

        /** @returns {this is AtUriWithDid} */
        authorityIsDidString() {
            return isDidString(this.components.authority);
        }

        /** @returns {Promise<AtUriWithDid>} */
        async withDidAuthority() {
            if (this.authorityIsDidString()) {
                return this;
            } else {
                const did = await resolveAtprotoHandle(this.authority);
                if (!did) {
                    throw Error(`Unable to resolve handle ${this.pickAuthority()}`);
                }
                /** @type {AtUriComponents & { authority: DidString }} */
                const components = { ...this.components, authority: did };
                return /** @type {AtUriWithDid} */ (new AtUri(components));
            }
        }

        pickAuthority() {
            if ('collection' in this) {
                return new AtUri(this.authority);
            } else {
                return this;
            }
        }

        toString() {
            let ret = `at://${this.authority}`;
            if ('collection' in this.components) {
                ret += `/${this.components.collection}`;
                if ('rkey' in this.components) {
                    ret += `/${this.components.rkey}`;
                }
            }
            return ret;
        }
    }

    /**
     * @param {Event & { readonly target: HTMLAnchorElement }} event
     * @param {AtUri} uri
     * @returns {Promise<void>}
     */
    async function atprotoFallback(event, uri) {
        await initFallbackBehavior;
        switch (config.atproto?.fallbackBehavior) {
            case 'openPds':
                event.preventDefault();
                const uriWithDid = await uri.withDidAuthority();
                const url = await pdsXrpcUrlForAtUri(uriWithDid);
                if (url !== undefined) {
                    safeOpen(url);
                    break;
                }
                console.warn(`Missing PDS for ${uri.authority}${uri.authorityIsDidString() ? '' : ` (${uriWithDid.authority})`}`);
                // Fall-through
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
     * @param {AtUriWithDid} uri
     * @returns {Promise<string | void>}
     */
    async function pdsXrpcUrlForAtUri(uri) {
        const pds = pdsFromDidDoc(await resolveDid(uri.components.authority));
        if (pds === undefined) {
            return;
        }

        if ('collection' in uri.components) {
            if ('rkey' in uri.components) {
                return `${pds}/xrpc/com.atproto.repo.getRecord?repo=${uri.authority}&collection=${uri.components.collection}&rkey=${uri.components.rkey}`;
            } else {
                return `${pds}/xrpc/com.atproto.repo.listRecords?repo=${uri.authority}&collection=${uri.components.collection}`;
            }
        } else {
            return `${pds}/xrpc/com.atproto.repo.describeRepo?repo=${uri.authority}`;
        }
    }

    // UTILITIES - Bridgy Fed

    /**
     * @param {AtUri} uri
     * @returns {string}
     */
    function bridgeUrlFromAtUri(uri) {
        if ('collection' in uri.components) {
            return `https://bsky.brid.gy/convert/ap/${uri}`;
        } else {
            return `https://bsky.brid.gy/ap/${uri.authority}`;
        }

    }

    /** @type {Set<string>} */
    const bridgedAuthorities = new Set();
    /**
     * @param {AtUri} uri
     * @returns {Promise<boolean>}
     */
    async function checkBridge(uri) {
        return bridgedAuthorities.has(uri.authority)
            || (
                uri.authority in resolvedHandles
                && bridgedAuthorities.has(/** @type {string} */(resolvedHandles[uri.authority]))
            )
            || fetch(bridgeUrlFromAtUri(uri), {
                method: 'HEAD',
                headers: acceptAs2Headers,
                referrer: '',
            })
                .then(res => {
                    if (res.ok) {
                        bridgedAuthorities.add(uri.authority);
                        return true;
                    }
                    return false;
                });
    }
})();
