// ==UserScript==
// @name         Booru Sync
// @description  Sync faves and upvotes across boorus.
// @version      1.3.8
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
const TIMEOUT = 30 * 1e3;

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

let activeSyncs = [];

class SyncManager {
  constructor(booruData, apiKey, settings, isSource = false) {
    const {name, host, filterId} = booruData;
    this.name = name;
    this.host = host;
    this.apiKey = apiKey.trim();
    this.filterId = filterId;
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

    /* Must be initialized by subclass */
    this.imageResultsProp = null;
    this.imageIdProp = null;
    this.searchApi = null;
    this.reverseSearchApi = null;
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
          q: encodeSearch(searchTerm),
          filter_id: this.filterId,
          per_page: RESULTS_PER_PAGE,
          key: this.apiKey,
          page: page,
        });
        const url = 'https://' + this.host + this.searchApi + query;
        response = await makeRequest(url).then(resp => {
          if (resp.status == 200) {
            return resp.response;
          } else {
            this.log('Error while fetching ' + linkify(url));
            if (resp.response.error) this.log('Error message: ' + resp.response.error);
            console.log(resp);
            throw new Error();
          }
        });

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
      } while (response.interactions.length > 0);

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
        this.report[interactionReportType].suspected.push({sourceHost: image.host, source: image.id, dest: id});
      } else if (!id && timeout) {
        this.log('[Error] Connection timed out');
        this.report.timeouts.push({id: image.id, host: image.host});
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

    const {hash, orig_hash, computedHash} = image;
    let {destId, interaction} = await this.searchByHash([hash, orig_hash]);
    let hashMatch = true;
    let timeout = false;

    if (!destId && this.useFallback) {
      if (!computedHash) {
        let hash;
        try {
          hash = await Promise.race([
            this.performClientSideHash(image),
            new Promise(resolve => {

              /**
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
            ({destId, interaction} = await this.searchByHash(hash));
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
  searchByHash(hashes) {
    const searchItems = [];
    hashes.forEach(hash => {
      searchItems.push('orig_sha512_hash:' + hash);
      searchItems.push('sha512_hash:' + hash);
    });
    const query = makeQueryString({
      q: encodeSearch(searchItems.join(' || ')),
      filter_id: this.filterId,
      key: this.apiKey,
    });
    const url = 'https://' + this.host + this.searchApi + query;

    return makeRequest(url)
      .then(this.handleResponse)
      .then(json => {
        const destId = (json[this.imageResultsProp].length > 0) ? json[this.imageResultsProp][0].id : null;
        const interaction = {
          fave: json.interactions.some(
            inter => inter[this.imageIdProp] == destId && inter.interaction_type == 'faved'
          ),
          like: json.interactions.some(
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

    return makeRequest(fullImageURL, 'GET', 'arraybuffer')
      .then(this.handleResponse)
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
        setClientHash(image, hashHex);
        return [hashHex];
      });
  }
  handleResponse(resp) {
    if (resp.timeout || resp.error || resp.status !== 200) {
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
      return makeRequest('https://' + this.host, 'GET', 'text')
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

    const clientHash = getClientHash(imageResponse);
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
        const {sourceHost, source, dest} = record;
        this.log();
        this.log(`${indent(1)}source: ${linkify(`https://${sourceHost}/images/${source}`)}`);
        this.log(`${indent(1)}=> target: ${linkify(`https://${this.host}/images/${dest}`)}`);
      }
    }
    if (this.report.timeouts.length > 0) {
      this.log();
      this.log('The script timed out while downloading the following files:');
      for (const img of this.report.timeouts) {
        this.log(indent(1) + linkify(`https://${img.host}/images/${img.id}`));
      }
    }
  }
  log(message = '') {
    message = `${this.name}: ${message}`;
    log(message);
  }
}

class PhilomenaSyncManager extends SyncManager {
  constructor(booruData, apiKey, settings, isSource = false) {
    super(booruData, apiKey, settings, isSource);
    this.imageResultsProp = 'images';
    this.imageIdProp = 'image_id';
    this.searchApi = '/api/v1/json/search/images';
    this.reverseSearchApi = '/api/v1/json/search/reverse';
  }
  async makeInteractionRequest(url, body) {
    const resp = await makeRequest(
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
    return makeRequest(url, 'POST')
      .then(this.handleResponse)
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
            } , 0);

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
  constructor(booruData, apiKey, settings, isSource = false) {
    super(booruData, apiKey, settings, isSource);
    this.imageResultsProp = 'search';
    this.imageIdProp = 'post_id';
    this.searchApi = '/search.json';
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
        q: encodeSearch(`location:${site} && id_at_location:${image.id}`),
        filter_id: this.filterId
      });
      const url = 'https://' + this.host + this.searchApi + query;
      const json = await makeRequest(url).then(this.handleResponse);
      if (json.total > 0) {
        destId = json[this.imageResultsProp][0].id;
        interaction = {
          fave: json.interactions.some(
            inter => inter[this.imageIdProp] == destId && inter.interaction_type == 'faved'
          ),
          like: json.interactions.some(
            inter => inter[this.imageIdProp] == destId && inter.interaction_type == 'voted' && inter.value == 'up'
          )
        };
      }
    }
    return {id: destId, interaction};
  }
  faveImage(imageId) {
    const url = window.location.origin + '/api/v2/interactions/fave';
    const body = {
      class: 'Image',
      id: String(imageId),
      value: 'true',
      _method: 'PUT',
    };
    return this.makeInteractionRequest(url, body);
  }
  likeImage(imageId) {
    const url = window.location.origin + '/api/v2/interactions/vote';
    const body = {
      class: 'Image',
      id: String(imageId),
      value: 'up',
      _method: 'PUT',
    };
    return this.makeInteractionRequest(url, body);
  }
  transformImageResponse(imageResponse) {
    imageResponse = super.transformImageResponse(imageResponse);
    imageResponse.tags = imageResponse.tags.split(',').map(tagName => tagName.trim());
    return imageResponse;
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

  const createCheckbox = (id, text, alt) => {
    const container = create('div');
    container.classList.add(`${SCRIPT_ID}__setting_container`);
    container.innerHTML = `
      <input id="${SCRIPT_ID}__${id}" type="checkbox" data-sync-setting="${id}">
      <label for="${SCRIPT_ID}__${id}" ${alt ? `title="${alt}"` : ''}>${text}</label>
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

  $(`#${SCRIPT_ID}_api_keys`, panelWrapper).appendChild(createApiInput());
  $(`#${SCRIPT_ID}_settings`, panelWrapper).appendChild(createCheckbox('sync_faves', 'Sync faves'));
  $(`#${SCRIPT_ID}_settings`, panelWrapper).appendChild(createCheckbox('sync_likes', 'Sync upvotes'));
  $(`#${SCRIPT_ID}_settings`, panelWrapper).appendChild(
    createCheckbox(
      'fallback',
      'Enable fallback',
      'Use client-side hashing and reverse image search to find matching images'
    ));
  $(`#${SCRIPT_ID}_sync_source`, panelWrapper).appendChild(createRadioGroup('sync_source', 'Sync source: '));
  $(`#${SCRIPT_ID}_sync_dest`, panelWrapper).appendChild(createCheckbox('dest_derpibooru', 'Derpibooru'));
  $(`#${SCRIPT_ID}_sync_dest`, panelWrapper).appendChild(createCheckbox('dest_ponybooru', 'Ponybooru'));
  $(`#${SCRIPT_ID}_sync_dest`, panelWrapper).appendChild(createCheckbox('dest_ponerpics', 'Ponerpics'));
  $(`#${SCRIPT_ID}_sync_dest`, panelWrapper).appendChild(createCheckbox('dest_twibooru', 'Twibooru'));

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
  Object.entries({
    derpibooru_api: '',
    ponybooru_api: '',
    ponerpics_api: '',
    twibooru_api: '',
    sync_faves: true,
    sync_likes: true,
    fallback: false,
    tag_filter: '',
    sync_source: 'derpibooru',
    dest_derpibooru: false,
    dest_ponybooru: false,
    dest_ponerpics: false,
    dest_twibooru: false,
  })
  .forEach(([key, defaultValue]) => {
    const val = GM_getValue(key, defaultValue);
    setSetting(key, val);
  });

  // disable Twibooru checkbox when not on the site
  if (window.location.host !== boorus.twibooru.host) {
    const checkbox = $(`#${SCRIPT_ID}__dest_twibooru`, panelWrapper);
    checkbox.checked = false;
    checkbox.disabled = true;
    checkbox.nextElementSibling.title = 'Syncing to Twibooru only works when on the site itself';
  }
}

function createSyncManager(booruData, ...args) {
  const Manager = (booruData.bor) ? BooruOnRailsSyncManager : PhilomenaSyncManager;
  return new Manager(booruData, ...args);
}

async function startSync() {
  const panel = $(`#${SCRIPT_ID}--panel`);
  if (panel.dataset.syncing == '1') {
    return;
  } else {
    panel.dataset.syncing = '1';
  }

  const settings = {
    syncFaves: getSetting('sync_faves'),
    syncLikes: getSetting('sync_likes'),
    useFallback: getSetting('fallback'),
    tagFilter: getSetting('tag_filter'),
  };

  const sourceId = getSetting('sync_source');
  const sourceBooru = createSyncManager(
    boorus[sourceId],
    getSetting(`${sourceId}_api`),
    settings,
    true
  );

  activeSyncs.push(sourceBooru);

  const destBoorus = {};
  for (const booruId in boorus) {
    if (!getSetting('dest_' + booruId) || booruId == sourceId) continue;
    destBoorus[booruId] = createSyncManager(
      boorus[booruId],
      getSetting(`${booruId}_api`),
      settings
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

  // reports
  Object.values(destBoorus).forEach(booru => booru.printReport());

  log();
  log('All done!');

  panel.dataset.syncing = '0';
  activeSyncs = [];
}

function setSetting(settingId, val) {
  const panel = $(`#${SCRIPT_ID}--panel`);
  const ele = $(`[data-sync-setting="${settingId}"]`, panel);

  if (!ele) return;
  if (ele.matches(`.${SCRIPT_ID}--input-sensitive`)) {
    ele.dataset.content = val;
    ele.value = '*'.repeat(val.length);
  } else if (ele.matches('[type="text"]')) {
    ele.value = val;
  } else if (ele.matches('[type="checkbox"]')) {
    ele.checked = val;
  } else if (ele.matches(`span.${SCRIPT_ID}__radio-button-container`)) {
    $(`input[value="${val}"]`, ele).checked = true;
  }
}

function getSetting(settingId) {
  const panel = $(`#${SCRIPT_ID}--panel`);
  const ele = $(`[data-sync-setting="${settingId}"]`, panel);

  if (!ele) return;
  if (ele.matches(`.${SCRIPT_ID}--input-sensitive`)) {
    return ele.dataset.content;
  } else if (ele.matches('[type="text"]')) {
    return ele.value;
  } else if (ele.matches('[type="checkbox"]')) {
    return ele.checked;
  } else if (ele.matches(`span.${SCRIPT_ID}__radio-button-container`)) {
    return $('input:checked', ele).value;
  } else {
    return null;
  }
}

function makeRequest(
  url,
  method = 'GET',
  responseType = 'json',
  additionalHeaders = {},
  data = ''
) {
  return new Promise((resolve) => {
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
      onload: resp => resolve(resp),
      onerror: resp => resolve({error: true, url: resp.finalUrl, response: resp}),
      ontimeout: () => resolve({timeout: true, error: true}),
    });
  });
}

function makeQueryString(queries) {
  return '?' + Object
    .entries(queries)
    .map(arr => arr.join('='))
    .join('&');
}

function encodeSearch(searchTerm) {
  return searchTerm
    .split(' ')
    .map(unsafeWindow.encodeURIComponent)
    .join('+');
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
  const imgLink = 'https://' + image.host + '/images/' + image.id;
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

function getClientHash(image) {
  const store = GM_getValue('hash_store', {});
  return store[image.host]?.[image.id]?.hash;
}

function setClientHash(image, hash) {
  const store = GM_getValue('hash_store', {});
  if (!store[image.host]) store[image.host] = {};
  store[image.host][image.id] = {hash, timestamp: Date.now()};
  GM_setValue('hash_store', store);
}

initCSS();
initUI();
})();
