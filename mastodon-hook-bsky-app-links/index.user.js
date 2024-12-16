// ==UserScript==
// @name        fedibird.com - Hook bsky.app links
// @namespace   https://github.com/tesaguri
// @match       https://fedibird.com/web/*
// @grant       none
// @version     1.0.0
// @updateURL   https://github.com/tesaguri/userscripts/raw/main/mastodon-hook-bsky-app-links/index.user.js
// @author      Daiki "tesaguri" Mizukami
// @license     GPL-3.0-only; https://www.gnu.org/licenses/gpl-3.0.txt
// @description Open bsky.app links via Bridgy Fed or PDS
// ==/UserScript==

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
 * @typedef {`did:${string}`} DidString
 * @typedef {{ type: LdRequired<string>, serviceEndpoint: LdRequired<LdId> }} Service
 * @typedef {LdId & { service?: LdOptional<Service> }} DidDocument
 */

(() => {
    // INIT

    /** @type {HTMLInputElement | null} */
    let searchInput = document.querySelector('input.search__input');
    if (!searchInput) {
        /** @type {MutationCallback} */
        function searchForSearchInput(records, observer) {
            for (const { addedNodes } of records) {
                for (const node of addedNodes) {
                    if (node instanceof Element) {
                        searchInput = node.querySelector('input.search__input');
                        if (searchInput) {
                            observer.disconnect();
                            return;
                        }
                    }
                }
            }
        }
        new MutationObserver(searchForSearchInput)
            .observe(document.body, {
                childList: true,
                subtree: true,
            });
    }

    const acceptAs2Headers = new Headers([['accept', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"']]);
    addEventListener('click', e => {
        const target = e.target;
        if (!(target instanceof HTMLAnchorElement) || !target.classList.contains('unhandled-link') || !target.href.startsWith('https://bsky.app/profile/') || target.classList.contains('status-url-link')) {
            return;
        }

        const components = atComponentsFromBskyUrl(target.href);
        if (!components) {
            return;
        }

        e.preventDefault();

        let authority = components[0];
        const collection = components[1];
        const rkey = components[2];
        if (collection === undefined || collection === 'app.bsky.feed.post') {
            checkBridge(authority)
                .then(async isBridged => {
                    if (isBridged) {
                        submitSearch(bridgeUrlFromComponents(authority, collection, rkey));
                        return;
                    }
                    safeOpen(await pdsXrpcUrlForComponents(authority, collection, rkey));
                });
        } else {
            pdsXrpcUrlForComponents(authority, collection, rkey).then(safeOpen);
        }
    });

    // UTILITIES - Generic

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
        if (!searchInput) return;
        searchInput.focus();
        // <https://hustle.bizongo.in/simulate-react-on-change-on-controlled-components-baa336920e04>
        const valueProperty = /** @type {NonNullable<ReturnType<typeof Object.getOwnPropertyDescriptor>>} */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'));
        const setValue = /** @type {NonNullable<typeof valueProperty.set>} */ (valueProperty.set);
        setValue.call(searchInput, query);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
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
    function assertIsId(x) {
        if (!(
            typeof x === 'string' ||
            ( '@id' in x && typeof x['@id'] === 'string') ||
            ( 'id' in x && typeof x.id === 'string')
        )) {
            throw Error('Argument is not an `@id`');
        }
    }

    /**
     * @param {any} x
     * @returns {asserts x is DidDocument}
     */
    function assertIsDidDocument(x) {
        assertIsId(x);
        // @ts-expect-error // implicitly asserting that `x` is an object.
        'service' in x
            && (x.service === null || asArray(x.service).forEach(assertIsService));
    }

    /**
     * @param {any} x
     * @returns {asserts x is Service}
     */
    function assertIsService(x) {
        if (typeof firstOfSet(x.type) !== 'string') {
            throw Error('Service must have a type');
        }
        for (const serviceEndpoint of asArray(x.serviceEndpoint)) {
            assertIsId(serviceEndpoint);
        }
    }

    /**
     * @param {LdId} node
     * @returns {string}
     */
    function idOf(node) {
        if (typeof node === 'string') {
            return node;
        } else if ('@id' in node) {
            return node['@id'];
        } else {
            return node.id;
        }
    }

    /**
     * @template T
     * @param {LdOptional<T> | undefined} value
     * @returns {(T | null)[]}
     */
    function asArray(value) {
        if (value instanceof Array) {
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
        if (set instanceof Array) {
            return set.find(x => x !== null);
        } else {
            return set;
        }
    }

    // UTILITIES - AT Protocol

    const acceptDnsJsonHeaders = new Headers([['accept', 'application/dns-json']]);
    /** @type {Record<string, DidString>} */
    const resolvedHandles = {};
    /**
     * @param {string} handle
     * @returns {Promise<DidString | void>}
     */
    async function resolveAtHandle(handle) {
        handle = handle.toLowerCase();
        if (handle in resolvedHandles) {
            return resolvedHandles[handle];
        }
        const ret = await resolveAtHandleInner(handle);
        if (ret) {
            resolvedHandles[handle] = ret;
            return ret;
        }
    }

    /**
     * @param {string} handle
     * @returns {Promise<DidString | void>}
     */
    async function resolveAtHandleInner(handle) {
        try {
            const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`, {
                headers: acceptDnsJsonHeaders,
                referrer: '',
            });
            if (res.ok) {
                // We are intentionally loose about the `any` type here because a `TypeError` would
                // be caught by the `try` block just fine.
                const answers = /** @type {any} */ (await res.json()).Answer;
                if (answers instanceof Array) {
                    const expectedName = `_atproto.${handle}`;
                    for (const answer of answers) {
                        /** @type {any} */
                        const ans = answer;
                        if (ans.name === expectedName && ans.type === 16 && ans.data?.startsWith('"did=did:') && ans.data.endsWith('"')) {
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
            .find(service => asArray(service?.type).includes('AtprotoPersonalDataServer'));
        if (service) {
            return idOf(firstOfSet(service.serviceEndpoint));
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
            did = await resolveAtHandle(authority);
            if (!did) {
                throw Error(`Unable to resolve handle at://${authority}`);
            }
        }
        const pds = pdsFromDidDoc(await resolveDid(did));
        return rkey === undefined
            ? `${pds}/xrpc/com.atproto.repo.describeRepo?repo=${did}`
            : `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`;
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
    function bridgeUrlFromComponents(authority, collection, rkey) {
        return rkey === undefined
            ? `https://bsky.brid.gy/ap/${authority}`
            : `https://bsky.brid.gy/convert/ap/at://${authority}/${collection}/${rkey}`;

    }

    const bridgedAuthorities = new Set();
    /**
     * @param {string} authority
     * @returns {Promise<boolean>}
     */
    async function checkBridge(authority) {
        return bridgedAuthorities.has(authority) ||
            fetch(bridgeUrlFromComponents(authority), {
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
    function atComponentsFromBskyUrl(url) {
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
