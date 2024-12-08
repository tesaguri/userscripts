// ==UserScript==
// @name        fedibird.com - Hook bsky.app links
// @namespace   https://github.com/tesaguri
// @match       https://fedibird.com/web/*
// @grant       none
// @version     1.0.0
// @updateURL   https://github.com/tesaguri/userscripts/raw/main/fedibird-hook-bsky-app-links/index.user.js
// @author      Daiki "tesaguri" Mizukami
// @license     GPL-3.0-only; https://www.gnu.org/licenses/gpl-3.0.txt
// @description Open bsky.app links via Bridgy Fed or PDS
// ==/UserScript==

(() => {
    // INIT

    let searchInput = document.getElementsByClassName('search__input')[0];
    if (!searchInput) {
        function searchForSearchInput(records, observer) {
            for (const { addedNodes } of records) {
                for (const node of addedNodes) {
                    searchInput = node.getElementsByClassName('search__input')[0];
                    if (searchInput) {
                        observer.disconnect();
                        return;
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
                    }
                    safeOpen(await pdsXrpcUrlForComponents(authority, collection, rkey));
                });
        } else {
            pdsXrpcUrlForComponents(authority, collection, rkey).then(safeOpen);
        }
    });

    // UTILITIES - Generic

    function safeOpen(url, target, windowFeatures) {
        const defaultWindowFeatures = 'noreferrer';
        return open(url, target, windowFeatures ? `${defaultWindowFeatures},${windowFeatures}` : defaultWindowFeatures);
    }

    // UTILITIES - Fedibird

    function submitSearch(query) {
        if (!searchInput) return;
        searchInput.focus();
        // <https://hustle.bizongo.in/simulate-react-on-change-on-controlled-components-baa336920e04>
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setValue.call(searchInput, query);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        // FIXME: Doesn't work
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    }

    // UTILITIES - AT Protocol

    const acceptDnsJsonHeaders = new Headers([['accept', 'application/dns-json']]);
    const resolvedHandles = {};
    async function resolveAtHandle(handle) {
        handle = handle.toLowerCase();
        if (handle in resolvedHandles) {
            return resolvedHandles[handle];
        }
        const ret = await resolveHandleInner(handle);
        if (ret) {
            resolvedHandles[handle] = ret;
            return ret;
        }
    }

    async function resolveHandleInner(handle) {
        try {
            const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`, {
                headers: acceptDnsJsonHeaders,
                referrer: '',
            });
            if (res.ok) {
                const json = await res.json();
                const expectedName = `_atproto.${handle}`;
                for (const answer of json?.Answer ?? []) {
                    if (answer.name === expectedName && answer.type === 16 && answer.data?.startsWith('"did=') && answer.data.endsWith('"')) {
                        return answer.data.slice(5, -1);
                    }
                }
            }
        } catch {
            // Fall back on well-known
        }
        try {
            const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
                method: 'HEAD',
                referrer: '',
            });
            if (res.ok) {
                return await res.text().trim();
            }
        } catch {
            // noop
        }
    }

    function pdsFromDidDoc(doc) {
        for (const service of asArray(doc.service)) {
            if (asArray(service.type).includes('AtprotoPersonalDataServer')) {
                return service.serviceEndpoint;
            }
        }
    }

    const acceptDidHeaders = new Headers([['accept', 'application/did+ld+json']]);
    async function resolveDid(did) {
        let url;
        if (did.startsWith('did:plc:')) {
            url = `https://plc.directory/${did}`;
        } else if (did.startsWith('did:web:')) {
            url = `https://${did.split(8)}/.well-known/did.json`;
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

        return await res.json();
    }

    function asArray(value) {
        if (value instanceof Array) {
            return value;
        } else if (value === null || value === undefined) {
            return [];
        } else {
            return [value];
        }
    }

    async function pdsXrpcUrlForComponents(authority, collection, rkey) {
        let did;
        if (authority.startsWith('did:')) {
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

    function bridgeUrlFromComponents(authority, collection, rkey) {
        const at = rkey === undefined ? `at://${authority}` : `at://${authority}/${collection}/${rkey}`;
        return `https://bsky.brid.gy/convert/ap/${at}`;
    }

    const bridgedAuthorities = new Set();
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
