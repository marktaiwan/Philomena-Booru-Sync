// ==UserScript==
// @name         Booru Sync
// @description  Sync faves and upvotes across boorus.
// @version      1.4.7
// @author       Marker
// @license      MIT
// @namespace    https://github.com/marktaiwan/
// @homepageURL  https://github.com/marktaiwan/Philomena-Booru-Sync
// @supportURL   https://github.com/marktaiwan/Philomena-Booru-Sync/issues
// @match        *://*.derpibooru.org/*
// @match        *://*.trixiebooru.org/*
// @match        *://*.ponybooru.org/*
// @match        *://*.ponerpics.org/*
// @match        *://*.ponerpics.com/*
// @match        *://*.twibooru.org/*
// @connect      derpibooru.org
// @connect      ponybooru.org
// @connect      ponerpics.org
// @connect      twibooru.org
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @grant        unsafeWindow
// @inject-into  content
// @noframes
// ==/UserScript==

(function () {
'use strict';

const SCRIPT_ID = 'booru_sync';
const SECOND = 1e3;
const DAY = 24 * 60 * 60 * 1e3;
const TIMEOUT = 30 * SECOND;
const CACHE_AGE = 180 * DAY;
const CACHE_CAPACITY = 100_000;

const boorus = {
  derpibooru: {
    name: 'Derpibooru',
    host: 'derpibooru.org',
    filterId: 56027
  },
  ponybooru: {
    name: 'Ponybooru',
    host: 'ponybooru.org',
    filterId: 1554
  },
  ponerpics: {
    name: 'Ponerpics',
    host: 'ponerpics.org',
    filterId: 2
  },
  twibooru: {
    name: 'Twibooru',
    host: 'twibooru.org',
    filterId: 2,
    bor: true
  },
};

const defaultSettings = {
  derpibooru_api: '',
  ponybooru_api: '',
  ponerpics_api: '',
  twibooru_api: '',
  sync_faves: true,
  sync_likes: true,
  fallback: false,
  autorun: 0,
  tag_filter: '',
  sync_source: 'derpibooru',
  dest_derpibooru: false,
  dest_ponybooru: false,
  dest_ponerpics: false,
  dest_twibooru: false,
};

let activeSyncs = [];

/** @abstract */
class SyncManager {
  constructor(booruData, apiKey, settings, hashCache, isSource = false) {
    const {name, host, filterId} = booruData;
    this.name = name;
    this.host = host;
    this.apiKey = apiKey.trim();
    this.filterId = filterId;
    this.hashCache = hashCache;
    this.isSource = isSource;
    this.syncFaves = settings.syncFaves;
    this.syncLikes = settings.syncLikes;
    this.useFallback = settings.useFallback;
    this.tagFilter = settings.tagFilter.trim();
    this.faves = [];
    this.likes = [];
    this.ok = true;
    this.token = {content: null, counter: 0, createdAt: 0};
    this.report = {
      faves: {new: 0, notFound: 0, suspected: []},
      likes: {new: 0, notFound: 0, suspected: []},
      timeouts: []
    };

    /* Rate limiting related properties */
    this.hasRateLimit = false;
    this.rateLimitReset = null;

    /* Must be initialized by subclass */
    this.imageResultsProp = null;
    this.imageResultsProp = null;
    this.imageIdProp = null;
    this.searchApi = null;
    this.reverseSearchApi = null;
  }
  makeRequest(
    url,
    method = 'GET',
    responseType = 'json',
    additionalHeaders = {},
    data = '',
  ) {
    return new Promise(resolve => {
      const scriptName = GM_info.script.name.replace(/\W/g, '');
      const scriptVersion = GM_info.script.version;

      let headers = {'User-Agent': `${navigator.userAgent} ${scriptName}/${scriptVersion}`};
      headers = {...headers, ...additionalHeaders};

      GM_xmlhttpRequest({
        url,
        method,
        responseType,
        headers,
        data,
        timeout: TIMEOUT,
        onload: resolve,
        onerror: resp => resolve({error: true, ...resp}),
        ontimeout: () => resolve({error: true, timeout: true, finalUrl: url}),
      });
    });
  }
  async getInteractions(sourceResultsCount = {faves: 0, likes: 0}) {
    const RESULTS_PER_PAGE = 50;
    let response;
    const performSearch = async (name, searchTerm, sourceTotal) => {

      if (this.isSource && this.tagFilter !== '') {
        searchTerm = `${searchTerm} && (${this.tagFilter})`;
      }

      const accu = [];
      let page = 1;
      do {
        if (!this.ok) return;
        this.log('Getting ' + name + '... Page ' + String(page));
        const query = makeQueryString({
          q: searchTerm,
          filter_id: this.filterId,
          per_page: RESULTS_PER_PAGE,
          key: this.apiKey,
          page: page,
        });
        const url = 'https://' + this.host + this.searchApi + query;
        response = await this.makeRequest(url).then(this.handleResponse.bind(this));

        if (page == 1 && !this.isSource) {
          // shortcut when it takes less requests overall to
          // check the voting state of each image individually
          // then to fetch every page of interaction results
          const totalInteractions = response.total;
          const totalPages = Math.ceil(totalInteractions / RESULTS_PER_PAGE);
          if (totalPages > sourceTotal || sourceTotal == 0) return [];
        }

        const collection = response[this.imageResultsProp];
        collection.forEach(this.transformImageResponse, this);

        accu.push(...collection);
        page += 1;
      } while (response[this.imageResultsProp].length > 0);

      return accu;
    };

    const faves = (this.syncFaves) ? await performSearch('faves', 'my:faves', sourceResultsCount.faves) : [];
    const likes = (this.syncLikes) ? await performSearch('likes', '(my:upvotes, -my:faves)', sourceResultsCount.likes) : [];

    if (!this.ok) return;
    this.faves = faves;
    this.likes = likes;
    this.log('Getting interactions... Done.');
  }
  async sync(sourceFaves, sourceLikes) {

    // Filter out images that are already faved
    const sourceFavesFiltered = sourceFaves.filter(sourceImg => {
      return !this.faves.some(destImg => hashCompare(sourceImg, destImg));
    });

    // Filter out images that are already liked
    const sourceLikesFiltered = sourceLikes.filter(sourceImg => {
      return !this.likes.some(destImg => hashCompare(sourceImg, destImg));
    });

    sourceFavesFiltered.forEach(img => img.interaction = 'fave');
    sourceLikesFiltered.forEach(img => img.interaction = 'like');

    const processingQueue = [...sourceFavesFiltered, ...sourceLikesFiltered];
    const total = processingQueue.length;
    let counter = 0;
    for (const image of processingQueue) {
      if (!this.ok) return;

      let interactionReportType;
      let interactionCallback;
      if (image.interaction == 'fave') {
        interactionReportType = 'faves';
        interactionCallback = 'faveImage';
      }
      if (image.interaction == 'like') {
        interactionReportType = 'likes';
        interactionCallback = 'likeImage';
      }

      this.log(`Searching for image ${linkifyImage(image)} (${++counter}/${total})`);
      const {id, hashMatch, timeout, interaction: destInteraction} = await this.findImage(image);

      if (id && hashMatch) {
        if ((image.interaction == 'fave' && destInteraction.fave)
          || (image.interaction == 'like' && destInteraction.like)) {
          this.log('Image already synced');
          continue;
        }
        const success = await this[interactionCallback](id);
        if (success) {
          this.log('Success');
          this.report[interactionReportType].new++;
        } else {
          this.log(`[Error] Unable to sync: ${linkifyImage({host: this.host, id})}`);
        }
      } else if (id && !hashMatch) {
        this.log(`Possible match found for image '${linkifyImage(image)}' as '${linkifyImage({host: this.host, id})}'`);
        this.report[interactionReportType].suspected.push({sourceHost: image.host, source: image.id, dest: id, path: image.path});
      } else if (!id && timeout) {
        this.log('[Error] Connection timed out');
        this.report.timeouts.push({id: image.id, host: image.host, path: image.path});
      } else {
        this.log('Not found: ' + linkifyImage(image));
        this.report[interactionReportType].notFound++;
      }
    }

    this.log('Sync complete');
  }
  async findImage(image) {

    const handleErr = err => {
      if (err.timeout) {
        timeout = true;
      } else {
        this.log('[Error] Something went wrong');
        if (err.status) {
          this.log('[Error] Status code ' + err.status);
        }
      }
    };

    const {hash, orig_hash, computedHash, interaction: interactionType} = image;
    let {destId, interaction} = await this.searchByHash([hash, orig_hash], interactionType);
    let hashMatch = true;
    let timeout = false;

    if (!destId && this.useFallback) {
      if (!computedHash) {
        let hash;
        try {
          hash = await Promise.race([
            this.performClientSideHash(image),
            new Promise(resolve => {

              /*
               *  Dirty, ugly, evil, stupid, retarded hack because for
               *  SOME reason, GM_xmlhttpRequest will sometimes fail on
               *  large webm downloads WITHOUT triggering a timeout,
               *  causing performClientSideHash to hang indefinitely.
               */
              window.setTimeout(() => {
                resolve({timeout: true, error: true});
              }, TIMEOUT);

            })
          ]);
          if (hash.timeout) {
            throw hash;
          } else {
            ({destId, interaction} = await this.searchByHash(hash, interactionType));
          }
        } catch (err) {
          handleErr(err);
        }
      }
      if (!destId) {
        try {
          hashMatch = false;
          destId = await this.searchByImage(image);
        } catch (err) {
          handleErr(err);
          destId = null;
        }
      }
    }

    return {id: destId, hashMatch, timeout, interaction};
  }
  searchByImage() {
    // Implemented by subclass
    return null;
  }
  /**
   * @param {string[]} hashes
   * @param {'fave'|'like'} interactionType
   * @returns {Promise<{destId: number, interaction: {fave: boolean, like: boolean}}>}
   */
  searchByHash(hashes, interactionType) {
    const searchItems = [];
    hashes.forEach(hash => {
      searchItems.push('orig_sha512_hash:' + hash);
      searchItems.push('sha512_hash:' + hash);
    });
    const searchTermBase = searchItems.join(' || ');
    const interactionTerm = (interactionType == 'fave') ? 'my:faves' : 'my:upvotes';
    const searchTermComplete = (this.hasRateLimit)
      ? `-${interactionTerm} && (${searchTermBase})`
      : searchTermBase;
    const query = makeQueryString({
      q: searchTermComplete,
      filter_id: this.filterId,
      key: this.apiKey,
    });
    const url = 'https://' + this.host + this.searchApi + query;

    return this.makeRequest(url)
      .then(this.handleResponse.bind(this))
      .then(json => {
        const destId = (json[this.imageResultsProp].length > 0) ? json[this.imageResultsProp][0].id : null;
        const interaction = {
          fave: json.interactions?.some(
            inter => inter[this.imageIdProp] == destId && inter.interaction_type == 'faved'
          ),
          like: json.interactions?.some(
            inter => inter[this.imageIdProp] == destId && inter.interaction_type == 'voted' && inter.value == 'up'
          )
        };
        return {destId, interaction};
      });
  }
  performClientSideHash(image) {
    if (image.computedHash) return [image.hash];

    this.log(`Downloading image ${linkifyImage(image)} for client-side hashing`);

    // special case for svg uploads
    const fullImageURL = (image.mime_type !== 'image/svg+xml')
      ? image.fileURL
      : image.fileURL.replace('/view/', /download/).replace(/\.\w+$/, '.svg');

    return this.makeRequest(fullImageURL, 'GET', 'arraybuffer')
      .then(this.handleResponse.bind(this))
      .then(buffer => window.crypto.subtle.digest('SHA-512', buffer))
      .then(hashBuffer => {

        /*
         *  Transform the ArrayBuffer into hex string
         *  Code taken from: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest#Examples
         */
        // convert buffer to byte array
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        // convert bytes to hex string
        const hashHex = hashArray
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        image.computedHash = true;
        image.hash = hashHex;
        this.hashCache.set(image, hashHex);
        return [hashHex];
      });
  }
  handleResponse(resp) {
    if (resp.timeout || resp.error || resp.status !== 200) {
      const errorType = resp.timeout ? 'Timeout' : 'Error';
      this.log(`${errorType} while fetching ` + linkify(resp.finalUrl));
      if (resp.response.error) this.log('Error message: ' + resp.response.error);
      console.log({RequestResponse: resp});
      throw resp;
    }
    return resp.response;
  }
  getToken() {
    const tokenAge = (Date.now() - this.token.createdAt) * 1e-3 / 60;  // in hours

    if (this.token.content && this.token.counter < 500 && tokenAge < 6) {
      this.token.counter++;
      return this.token.content;
    } else {
      return this.makeRequest('https://' + this.host, 'GET', 'text')
        .then(resp => {
          const parser = new DOMParser();
          const text = resp.response;
          const doc = parser.parseFromString(text, 'text/html');
          const token = $('meta[name="csrf-token"]', doc).content;
          this.token.counter = 0;
          this.token.content = token;
          this.token.createdAt = Date.now();
          return token;
        });
    }
  }
  transformImageResponse(imageResponse) {
    imageResponse.host = this.host;
    imageResponse.path = this.imageResultsProp;

    const clientHash = this.hashCache.get(imageResponse);
    imageResponse.id = String(imageResponse.id);
    imageResponse.hash = clientHash || imageResponse.sha512_hash;
    imageResponse.computedHash = Boolean(clientHash);
    imageResponse.orig_hash = imageResponse.orig_sha512_hash;
    imageResponse.fileURL = makeAbsolute(imageResponse.representations.full, this.host);
    return imageResponse;
  }
  printReport() {

    const indent = (level = 0) => '  '.repeat(level);

    log();
    this.log('Syncing report:');
    if (this.syncFaves) {
      this.log();
      this.log(`${indent(1)}Faved images imported: ${this.report.faves.new}`);
      this.log(`${indent(1)}Faved images not found: ${this.report.faves.notFound}`);
    }
    if (this.syncLikes) {
      this.log();
      this.log(`${indent(1)}Upvoted images imported: ${this.report.likes.new}`);
      this.log(`${indent(1)}Upvoted images not found: ${this.report.likes.notFound}`);
    }
    if (this.report.faves.suspected.length > 0
      || this.report.likes.suspected.length > 0) {
      const records = [...this.report.faves.suspected, ...this.report.likes.suspected];

      this.log();
      this.log('Exact matches for the following images could not be found via hash.');
      this.log('But potential match was found through reverse image search:');

      for (const record of records) {
        const {sourceHost, source, dest, path} = record;
        this.log();
        this.log(`${indent(1)}source: ${linkify(`https://${sourceHost}/${path}/${source}`)}`);
        this.log(`${indent(1)}=> target: ${linkify(`https://${this.host}/${this.imageResultsProp}/${dest}`)}`);
      }
    }
    if (this.report.timeouts.length > 0) {
      this.log();
      this.log('The script timed out while downloading the following files:');
      for (const img of this.report.timeouts) {
        this.log(indent(1) + linkify(`https://${img.host}/${img.path}/${img.id}`));
      }
    }
  }
  log(message = '') {
    message = `${this.name}: ${message}`;
    log(message);
  }
}

class PhilomenaSyncManager extends SyncManager {
  constructor(booruData, apiKey, settings, hashCache, isSource = false) {
    super(booruData, apiKey, settings, hashCache, isSource);
    this.imageResultsProp = 'images';
    this.imageIdProp = 'image_id';
    this.searchApi = '/api/v1/json/search/images';
    this.reverseSearchApi = '/api/v1/json/search/reverse';
  }
  async makeInteractionRequest(url, body) {
    const resp = await this.makeRequest(
      url,
      'POST',
      'json',
      {'Content-Type': 'application/json', 'x-csrf-token': await this.getToken()},
      JSON.stringify(body)
    );
    if (resp.status != 200) {
      try {
        // When encountering an error, the response may not be in json.
        // In this situation, accessing resp.response on a malformed
        // response will cause it to throw a SyntaxError
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        resp.response;
      } catch (error) {
        if (error instanceof SyntaxError) {
          // delete the getter and replace it with a plain object
          delete resp.response;
          resp.response = {error: resp.responseText};
        } else {
          throw error;
        }
      }
      this.log('[Error] Unexpected status code ' + resp.status);
      if (resp.response.error) this.log('Error message: ' + resp.response.error);
    }
    return (resp.status == 200);
  }
  faveImage(imageId) {
    const url = 'https://' + this.host + '/images/' + imageId + '/fave';
    const body = {_method: 'POST'};
    return this.makeInteractionRequest(url, body);
  }
  likeImage(imageId) {
    const url = 'https://' + this.host + '/images/' + imageId + '/vote';
    const body = {up: true, _method: 'POST'};
    return this.makeInteractionRequest(url, body);
  }
  searchByImage(image) {
    const url = 'https://' + this.host + this.reverseSearchApi + '?url=' + image.fileURL;
    this.log(`Performing reverse image search for ${linkifyImage(image)}`);
    return this.makeRequest(url, 'POST')
      .then(this.handleResponse.bind(this))
      .then(json => {
        const results = json.images.filter(
          img => (img.duplicate_of === null && img.deletion_reason === null)
        );


        if (results.length <= 1) return (results.length === 1) ? results[0].id : null;

        /*
         *  There are more than one results.
         *  This is where things gets complicated.
         */
        const sourceImage = image;
        const jaccardIndex = (set1, set2) => {
          const intersect = set1.filter(tag => set2.includes(tag));
          return intersect.length / (set1.length + set2.length - intersect.length);
        };
        // calculate image similarity and assign a score
        const weights = {
          mime_type: 2,
          aspect_ratio: 4,
          resolution: 1,
          tags: 3,
        };
        const weightSum = Object.values(weights).reduce((sum, val) => sum += val);

        results.forEach(result => {
          const attributes = {
            mime_type: (result.mime_type == sourceImage.mime_type) ? 1 : 0,
            aspect_ratio: 1 - Math.tanh(Math.abs(sourceImage.aspect_ratio - result.aspect_ratio)),
            resolution: 1 - Math.tanh(
              Math.abs(
                (sourceImage.width * sourceImage.height) - (result.width * result.height)
              ) * 1e-3
            ),
            tags: jaccardIndex(sourceImage.tags, result.tags),
          };
          const score = Object
            .entries(weights)
            .reduce((sum, arr) => {
              const [attrName, weight] = arr;
              const attrScore = attributes[attrName] * (weight / weightSum);
              return sum + attrScore;
            }, 0);

          result.simScore = score;
        });

        const bestMatch = results.reduce(
          (bestMatch, current) => (bestMatch.simScore > current.simScore) ? bestMatch : current
        );
        return bestMatch.id;
      });
  }
}

class BooruOnRailsSyncManager extends SyncManager {
  constructor(booruData, apiKey, settings, hashCache, isSource = false) {
    super(booruData, apiKey, settings, hashCache, isSource);
    this.imageResultsProp = 'posts';
    this.imageIdProp = 'post_id';
    this.searchApi = '/api/v3/search/posts';
    this.hasRateLimit = true;
    this.rateLimitReset = null;
  }
  async makeRequest(...args) {
    if (this.rateLimitReset) {
      const remaining = secondsUntil(this.rateLimitReset);
      if (remaining > 0) {
        this.log(`Rate limit exceeded. Waiting ${remaining} seconds.`);
        await sleep((remaining + 5) * 1e3); // add an extra 5 seconds to be safe
        this.rateLimitReset = null;
      }
    }
    return super.makeRequest(...args);
  }
  handleResponse(resp) {
    super.handleResponse(resp);
    // check rate limiting
    const responseHeaders = parseResponseHeaders(resp.responseHeaders);
    if (responseHeaders.has('x-rl-remain')) {
      const remains = Number.parseInt(responseHeaders.get('x-rl-remain'), 10);
      if (remains <= 0) {
        this.rateLimitReset = responseHeaders.get('x-rl-reset');
      }
    }
    return resp.response;
  }
  async makeInteractionRequest(url, body) {
    const resp = await fetch(url, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': await this.getToken(),
      },
      body: JSON.stringify(body)
    });

    if (resp.status != 200) {
      const json = await resp.json();
      this.log('[Error] Unexpected status code ' + resp.status);
      if (json.error) this.log('Error message: ' + json.error);
    }
    return (resp.status == 200);
  }
  async findImage(image) {
    let hashMatch = true;
    let timeout = false;
    let {id, interaction} = await this.searchByApi(image);

    if (!id) {
      ({id, hashMatch, timeout, interaction} = await super.findImage(image));
    }
    return {id, hashMatch, timeout, interaction};
  }
  async searchByApi(image) {
    let destId = null;
    let interaction = {};

    if (image.host == 'derpibooru.org') {
      const site = 'derpibooru';
      const query = makeQueryString({
        q: `location:${site} && id_at_location:${image.id}`,
        filter_id: this.filterId
      });
      const url = 'https://' + this.host + this.searchApi + query;
      const json = await this.makeRequest(url).then(this.handleResponse.bind(this));
      if (json.total > 0) {
        destId = json[this.imageResultsProp][0].id;
        interaction = {
          fave: false,
          like: false,
        };
      }
    }
    return {id: destId, interaction};
  }
  faveImage(imageId) {
    const url = window.location.origin + '/api/v2/interactions/fave';
    const body = {
      class: 'Post',
      id: String(imageId),
      value: 'true',
      _method: 'PUT',
    };
    return this.makeInteractionRequest(url, body);
  }
  likeImage(imageId) {
    const url = window.location.origin + '/api/v2/interactions/vote';
    const body = {
      class: 'Post',
      id: String(imageId),
      value: 'up',
      _method: 'PUT',
    };
    return this.makeInteractionRequest(url, body);
  }
}

/** Class for storing computed image hash */
class HashCache {
  storageId = 'hash_store';
  version = 2;
  storageBase = {
    _version: this.version
  };
  store = {};
  modified = false;
  constructor(hosts) {
    let extensionStorage = GM_getValue(this.storageId, {...this.storageBase});

    // clear previous storage version
    if (extensionStorage._version !== this.version) {
      extensionStorage = {...this.storageBase};
      this.modified = true;
    }

    hosts.forEach(host => {
      const siteCache = extensionStorage?.[host] ?? [];
      this.store[host] = new TLRUCache(siteCache);
    });
  }
  set(image, hash) {
    this.modified = true;
    this.store[image.host].set(image.id, hash);
  }
  get(image) {
    return this.store[image.host].get(image.id);
  }
  saveToStorage() {
    const obj = {...this.storageBase};
    Object.keys(this.store).forEach(host => {
      obj[host] = this.store[host].toArray();
    });
    GM_setValue(this.storageId, obj);
  }
}

class TLRUCache {
  maxAge = CACHE_AGE;
  capacity = CACHE_CAPACITY;
  constructor(entries = []) {
    this.capacity = CACHE_CAPACITY;
    this.cache = new Map(entries);
  }
  set(key, value) {
    this.cache.set(key, {v: value, t: Date.now()});
    while (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }
  get(key) {
    const element = this.cache.get(key);
    if (!element) return undefined;
    const {v: value, t: timestamp} = element;

    // reorder element to the end of the list
    this.cache.delete(key);
    if (Date.now() - timestamp < this.maxAge) {
      this.cache.set(key, element);
    }

    return value;
  }
  toArray() {
    return Array.from(this.cache);
  }
}

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => parent.querySelectorAll(selector);
const create = ele => document.createElement(ele);

function initUI() {
  const searchForm = $('form[action="/search"]');
  const headerGroup = searchForm?.previousElementSibling;

  const panelButton = create('a');
  panelButton.classList.add('header__link');
  panelButton.href = '#';
  const iconOfSin = create('i');
  iconOfSin.classList.add('fa', 'fa-retweet');

  panelButton.addEventListener('click', togglePanel);

  panelButton.appendChild(iconOfSin);
  headerGroup?.append(panelButton);
}

function initCSS() {
  const CSS = `/* Generated by Booru Sync */
#${SCRIPT_ID}--panelWrapper {
  position: fixed;
  top: 0px;
  left: 0px;
  z-index: 10;
  display: flex;
  width: 100vw;
  height: 100vh;
  align-items: center;
  justify-content: center;
  background-color: rgba(0,0,0,0.5);
}

#${SCRIPT_ID}--panel {
  width: 90vw;
  max-width: 900px;
}

.${SCRIPT_ID}--header {
  padding: 0px 5px;
}

.${SCRIPT_ID}--body {
  max-height: calc(100vh - 80px);
  overflow: auto;
}

.${SCRIPT_ID}--table {
  display: grid;
  /*width: 600px;*/
  grid-template-columns: 150px 200px;
  grid-column-gap: 5px;
  grid-row-gap: 5px;
}

.${SCRIPT_ID}--table input {
  font-size: 12px;
  align-self: center;
  text-align: center;
}

.${SCRIPT_ID}__setting_container {
  display: inline-block;
  margin: 0px 4px;
}

.${SCRIPT_ID}__radio-button-container span {
  margin: 0px 4px;
}

.${SCRIPT_ID}__radio-button-container input {
  margin-right: 4px
}

#${SCRIPT_ID}_logger_output {
  width: 100%;
  height: 300px;
  cursor: text;
  overflow: auto;
}

.${SCRIPT_ID}_logger_entry {
  line-height: 1.15em;
  white-space: pre-wrap;
}

.${SCRIPT_ID}_logger_entry:last-child {
  display: inline-block;
  margin-bottom: 1.15em;
}

.${SCRIPT_ID}_logger_entry a {
  background-color: hsl(0 0% 50% / 0.15);
}
`;
  if (!document.getElementById(`${SCRIPT_ID}-style`)) {
    const styleElement = document.createElement('style');
    styleElement.setAttribute('type', 'text/css');
    styleElement.id = `${SCRIPT_ID}-style`;
    styleElement.innerHTML = CSS;
    document.body.insertAdjacentElement('afterend', styleElement);
  }
}

function togglePanel() {
  const panel = $(`#${SCRIPT_ID}--panelWrapper`);
  if (panel) {
    panel.remove();
  } else {
    openPanel();
  }
}

function openPanel() {

  const createApiInput = () => {
    const onFocus = ({target: input}) => {
      input.value = input.dataset.content;
    };
    const onBlur = ({target: input}) => {
      input.dataset.content = input.value;
      input.value = '*'.repeat(input.value.length);
    };
    const frag = document.createDocumentFragment();
    for (const key in boorus) {
      const span = create('span');
      const input = create('input');
      span.innerText = boorus[key].name + ' API key:';
      input.classList.add(`${SCRIPT_ID}--input-sensitive`);
      input.type = 'text';
      input.dataset.syncSetting = key + '_api';
      input.dataset.content = '';
      input.addEventListener('focus', onFocus);
      input.addEventListener('blur', onBlur);

      frag.appendChild(span);
      frag.appendChild(input);
    }
    return frag;
  };

  const createNumericField = (id, text, alt) => {
    alt ??= '';
    const container = create('div');
    container.classList.add(`${SCRIPT_ID}__setting_container`);
    container.innerHTML = `
      <label title="${alt}">
        <input type="number" min="0" max="360" data-sync-setting="${id}">
        ${text}
      </label>
    `;
    return container;
  };

  const createCheckbox = (id, text, alt) => {
    alt ??= '';
    const container = create('div');
    container.classList.add(`${SCRIPT_ID}__setting_container`);
    container.innerHTML = `
      <label title="${alt}">
        <input type="checkbox" data-sync-setting="${id}">
        ${text}
      </label>
    `;
    return container;
  };

  const createRadioGroup = (id, text) => {
    const frag = document.createDocumentFragment();
    const groupLabel = create('label');
    groupLabel.innerText = text;

    const buttonSet = create('span');
    buttonSet.dataset.syncSetting = id;
    buttonSet.classList.add(`${SCRIPT_ID}__radio-button-container`);

    let n = 1;
    const groupId = id + '_group';
    for (const key in boorus) {
      const booru = boorus[key];

      const span = create('span');
      const input = create('input');
      const label = create('label');
      const selectionId = groupId + '_' + n;
      ++n;

      span.classList.add(`${SCRIPT_ID}__setting_container`);

      input.type = 'radio';
      input.name = groupId;
      input.id = selectionId;
      input.value = key;

      label.setAttribute('for', selectionId);
      label.innerText = booru.name;

      span.appendChild(input);
      span.appendChild(label);
      buttonSet.appendChild(span);
    }

    frag.appendChild(groupLabel);
    frag.appendChild(buttonSet);
    return frag;
  };

  const panelWrapper = create('div');
  panelWrapper.id = `${SCRIPT_ID}--panelWrapper`;
  panelWrapper.innerHTML = `
<div id="${SCRIPT_ID}--panel" class="">
  <div class="${SCRIPT_ID}--header block__header">
    <b>Booru Sync</b>
    <button id="${SCRIPT_ID}--close-button" class="button">🗙</button>
  </div>
  <div class="${SCRIPT_ID}--body block__tab">
    Sync faves and likes between boorus
    <h4 class="block__header--light">API keys</h4>
    <div id="${SCRIPT_ID}_api_keys" class="${SCRIPT_ID}--table"></div>
    <h4 class="block__header--light">Settings</h4>
    <div id="${SCRIPT_ID}_settings"></div>
    <h4 class="block__header--light">Syncing</h4>
    <div id="${SCRIPT_ID}_sync_source" class="field field-block"></div>
    <div id="${SCRIPT_ID}_sync_dest" class="field field-block">
      <label>Sync destination: </label>
    </div>
    <div id="${SCRIPT_ID}_sync_filter" class="field field-block">
      <label>Filter by tags: </label>
    </div>
    <h5>Logs:</h5>
    <div id="${SCRIPT_ID}_logger_output" class="input field" tabindex="0"></div>
    <button id="${SCRIPT_ID}_start_sync" type="button"
      class="button button--state-primary"
      data-click-preventdefault="true">
      Start sync
    </button>
    <button id="${SCRIPT_ID}_cancel_sync" type="button"
      class="button button--state-danger"
      title="Hammer time"
      data-click-preventdefault="true">
      Stop!
    </button>
    <button id="${SCRIPT_ID}_export_log" type="button"
      class="button button--state-warning"
      title="Save log to file"
      style="float: right;"
      data-click-preventdefault="true">
      Save log
    </button>
  </div>
</div>
`;

  $(`#${SCRIPT_ID}_api_keys`, panelWrapper).append(
    createApiInput(),
  );
  $(`#${SCRIPT_ID}_settings`, panelWrapper).append(
    createCheckbox('sync_faves', 'Sync faves'),
    createCheckbox('sync_likes', 'Sync upvotes'),
    createCheckbox(
      'fallback',
      'Enable fallback',
      'Use client-side hashing and reverse image search to find matching images',
    ),
    createNumericField(
      'autorun',
      'Autorun interval',
      'Schedule the script to automatically run every X days. 0 to disable.'),
  );

  $(`#${SCRIPT_ID}_sync_source`, panelWrapper).append(
    createRadioGroup('sync_source', 'Sync source: '),
  );
  $(`#${SCRIPT_ID}_sync_dest`, panelWrapper).append(
    createCheckbox('dest_derpibooru', 'Derpibooru'),
    createCheckbox('dest_ponybooru', 'Ponybooru'),
    createCheckbox('dest_ponerpics', 'Ponerpics'),
    createCheckbox('dest_twibooru', 'Twibooru'),
  );

  // tag filtering
  const tagFilter = create('input');
  tagFilter.id = `${SCRIPT_ID}__tag_filter`;
  tagFilter.type = 'text';
  tagFilter.size = '40';
  tagFilter.dataset.syncSetting = 'tag_filter';
  $(`#${SCRIPT_ID}_sync_filter`, panelWrapper).appendChild(tagFilter);

  // close panel
  let mousedownTarget, mouseupTarget;
  panelWrapper.addEventListener('mousedown', e => mousedownTarget = e.target);
  panelWrapper.addEventListener('mouseup', e => mouseupTarget = e.target);
  panelWrapper.addEventListener('click', e => {
    if (e.target == e.currentTarget && mousedownTarget != mouseupTarget) return;
    if (e.target != e.currentTarget && !e.target.matches(`#${SCRIPT_ID}--close-button`)) return;
    if ($(`#${SCRIPT_ID}--panel`)?.dataset.syncing == '1') return;
    panelWrapper.remove();
  });

  // save changes
  panelWrapper.addEventListener('input', e => {
    if (!e.target.matches('[data-sync-setting], input[type="radio"]')) return;
    let ele = e.target;

    if (ele.matches('input[type="radio"]')) {
      ele = ele.closest('[data-sync-setting]');
    }

    const key = ele.dataset.syncSetting;
    const val = getSetting(key);
    GM_setValue(key, val);
  });

  // bind listener to button
  $(`#${SCRIPT_ID}_start_sync`, panelWrapper).addEventListener('click', startSync);
  $(`#${SCRIPT_ID}_export_log`, panelWrapper).addEventListener('click', downloadLog);
  $(`#${SCRIPT_ID}_cancel_sync`, panelWrapper).addEventListener('click', () => {
    presidentMadagascar(activeSyncs);
  });

  document.body.appendChild(panelWrapper);

  // init settings
  initKeyVal();

  // disable Twibooru checkbox when not on the site
  if (window.location.host !== boorus.twibooru.host) {
    const checkbox = $(`.${SCRIPT_ID}__setting_container [data-sync-setting="dest_twibooru"]`, panelWrapper);
    checkbox.disabled = true;
    checkbox.parentElement.title = 'Syncing to Twibooru only works when on the site itself';
  }

}

function createSyncManager(booruData, ...args) {
  const Manager = (booruData.bor) ? BooruOnRailsSyncManager : PhilomenaSyncManager;
  return new Manager(booruData, ...args);
}

async function startSync() {
  const panel = $(`#${SCRIPT_ID}--panel`);
  if (panel) {
    if (panel.dataset.syncing == '1') {
      return;
    } else {
      panel.dataset.syncing = '1';
    }
  }

  const settings = {
    syncFaves: getSetting('sync_faves'),
    syncLikes: getSetting('sync_likes'),
    useFallback: getSetting('fallback'),
    tagFilter: getSetting('tag_filter'),
  };

  log('Loading client-side hash from script storage...');
  const hashCache = new HashCache(Object.values(boorus).map(booru => booru.host));
  log('Done');

  const sourceId = getSetting('sync_source');
  const sourceBooru = createSyncManager(
    boorus[sourceId],
    getSetting(`${sourceId}_api`),
    settings,
    hashCache,
    true
  );

  activeSyncs.push(sourceBooru);

  const destBoorus = {};
  for (const booruId in boorus) {
    if (!getSetting('dest_' + booruId) || booruId == sourceId) continue;
    destBoorus[booruId] = createSyncManager(
      boorus[booruId],
      getSetting(`${booruId}_api`),
      settings,
      hashCache
    );
    activeSyncs.push(destBoorus[booruId]);
  }

  log('Syncing from: ' + sourceBooru.name);
  log('Syncing to: ' + Object.values(destBoorus).map(booru => booru.name).join(', '));

  // get faves + likes from source
  sourceBooru.log('Begin fetching image interactions');
  await sourceBooru.getInteractions();
  sourceBooru.log();
  sourceBooru.log(`Result: ${sourceBooru.faves.length} faves and ${sourceBooru.likes.length} likes`);
  const sourceResultsCount = {
    faves: sourceBooru.faves.length,
    likes: sourceBooru.likes.length
  };

  // get faves + likes from target
  log('Begin fetching image interactions from sync targets');
  await Promise.allSettled(
    Object.values(destBoorus).map(booru => booru.getInteractions(sourceResultsCount))
  );

  // initiate import
  await Promise.allSettled(
    Object.values(destBoorus)
      .filter(booru => booru.ok)
      .map(booru => booru.sync(sourceBooru.faves, sourceBooru.likes))
  );

  if (hashCache.modified) {
    log('Saving client-side hash to storage...');
    hashCache.saveToStorage();
    log('Done');
  }

  // reports
  Object.values(destBoorus).forEach(booru => booru.printReport());

  log();
  log('All done!');

  if (panel) panel.dataset.syncing = '0';
  activeSyncs = [];
  GM_setValue('last_ran', Date.now());
}

function initKeyVal() {
  return Object
    .entries(defaultSettings)
    .map(([key, defaultValue]) => {
      let val = GM_getValue(key, defaultValue);
      if (key == 'dest_twibooru'
        && window.location.host !== boorus.twibooru.host
      ) {
        val = false;
      }
      setSetting(key, val);
      return val;
    });
}

function setSetting(settingId, val) {
  const panel = $(`#${SCRIPT_ID}--panel`);
  if (!panel) return;

  const ele = $(`[data-sync-setting="${settingId}"]`, panel);
  if (!ele) return;
  if (ele.matches(`.${SCRIPT_ID}--input-sensitive`)) {
    ele.dataset.content = val;
    ele.value = '*'.repeat(val.length);
  } else if (ele.matches('[type="text"]')) {
    ele.value = val;
  } else if (ele.matches('[type="number"]')) {
    ele.value = val;
  } else if (ele.matches('[type="checkbox"]')) {
    ele.checked = val;
  } else if (ele.matches(`span.${SCRIPT_ID}__radio-button-container`)) {
    $(`input[value="${val}"]`, ele).checked = true;
  }
}

function getSetting(settingId) {
  const panel = $(`#${SCRIPT_ID}--panel`);

  // background task
  if (!panel) {
    return GM_getValue(settingId, defaultSettings[settingId]);
  }

  const ele = $(`[data-sync-setting="${settingId}"]`, panel);

  if (!ele) return;
  if (ele.matches(`.${SCRIPT_ID}--input-sensitive`)) {
    return ele.dataset.content;
  } else if (ele.matches('[type="text"]')) {
    return ele.value;
  } else if (ele.matches('[type="number"]')) {
    return Number.parseInt(ele.value);
  } else if (ele.matches('[type="checkbox"]')) {
    return ele.checked;
  } else if (ele.matches(`span.${SCRIPT_ID}__radio-button-container`)) {
    return $('input:checked', ele).value;
  } else {
    return null;
  }
}

function makeQueryString(queries) {
  const params = new URLSearchParams(queries);
  return '?' + params.toString();
}

function presidentMadagascar(syncs) {
  // shut down everything
  syncs.forEach(sync => sync.ok = false);
  syncs = [];
  $(`#${SCRIPT_ID}--panel`).dataset.syncing = '0';
}

function makeAbsolute(path, host) {
  return path.match(/^(?:https?:)?\/\//) ? path : 'https://' + host + path;
}

function hashCompare(sourceImg, destImg) {
  return (sourceImg.orig_hash == destImg.orig_hash
    || sourceImg.orig_hash == destImg.hash
    || sourceImg.hash == destImg.orig_hash
    || sourceImg.hash == destImg.hash);
}

function linkify(href, text = href) {
  const a = create('a');
  a.href = href;
  a.target = '_blank';
  a.referrerPolicy = 'origin';
  a.relList.add('noreferrer', 'noopener');
  a.innerText = text;
  return a.outerHTML;
}

function linkifyImage(image) {
  const imgLink = 'https://' + image.host + '/' + image.path + '/' + image.id;
  return linkify(imgLink, image.id);
}

function log(message = '') {
  const output = $(`#${SCRIPT_ID}_logger_output`);
  if (!output) return;

  const MAX_DISPLAYED_ROW = 1000;
  const logEntryClass = `${SCRIPT_ID}_logger_entry`;
  const logEntry = create('span');
  logEntry.classList.add(logEntryClass);
  logEntry.innerHTML = message + '\n';
  output.appendChild(logEntry);

  if (output.childElementCount > MAX_DISPLAYED_ROW) {
    $(`.${logEntryClass}:not(.hidden)`).classList.add('hidden');
  }

  if (!output.matches(':hover')) output.scrollTop = output.scrollHeight;
}

function downloadLog() {
  const output = $(`#${SCRIPT_ID}_logger_output`).cloneNode(true);
  $$('a', output).forEach(anchor => anchor.innerText = anchor.href);

  const blob = new Blob([output.innerText], {type: 'text'});
  const anchor = create('a');
  anchor.setAttribute('href', URL.createObjectURL(blob));
  anchor.setAttribute('download', 'booru-sync.log');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function autorun() {
  const threshhold = getSetting('autorun') * DAY;
  const now = Date.now();
  const lastRan = GM_getValue('last_ran', 0);
  const elapsed = now - lastRan;
  if (threshhold !== 0 && elapsed > threshhold) {
    startSync();
  }
}

function parseResponseHeaders(str) {
  /** @type {Map<string, string>} */
  const headers = new Map();
  str
    .split('\r\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [, key, value] = line.match(/^([^:]+):\s*(.*)$/);
      headers.set(key, value);
    });
  return headers;
}

function secondsUntil(datestring) {
  const re = (/^(\d+-\d+-\d+) (\d{2}:\d{2}:\d{2}) UTC$/);
  const match = re.exec(datestring);
  if (match === null) throw Error('Unable to parse: ' + datestring);

  const [, date, time] = match;
  const now = Date.now();
  const then = Date.parse(`${date}T${time}.000+00:00`);
  return Math.ceil((then - now) / 1000);
}

function sleep(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

initCSS();
initUI();
autorun();
})();
