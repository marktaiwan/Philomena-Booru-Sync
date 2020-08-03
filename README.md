# Booru-Sync

#### Syncs user interactions (favorites/upvotes) between Derpibooru, Ponybooru, PonerPics, and Twibooru.

## Installation

Requires [Violentmonkey](https://violentmonkey.github.io/) or compatible userscript manager.  
[Click here to install](https://github.com/marktaiwan/Philomena-Booru-Sync/raw/master/booru-sync.user.js)

## Instructions

The button for opening the UI could be found next to the upload button.

Make sure you filled in all the API keys and is logged in to the sites you want to sync to.

The script trys to identify identical images on other boorus by the image's [hash value](https://developer.mozilla.org/en-US/docs/Glossary/hash). Normally it is done by simply requesting the data using the site API. However there an issue with Derpibooru that makes it returns only the hash value for pre-optimized images on many older uploads.

The "Enable fallback" setting tries to mitigate this by employing two additional methods to find matching images when the normal method failed to yield result:

 - Client-side hash calculation: Downloads the full image/video and calculates the hash value on the browser.

 - Reverse image search: Send the file url to the target booru for reverse image search, and potential matches are listed in the final report for manual review. (Not availiable for Twibooru)

 Bewarned that these methods are relatively bandwidth intensive, depending on the number of images the script needed to check. Use it sparingly.

 The "Filter by tags" field allows you to sync only selected images from the source booru. For example, you can use `created_at.gt:7 days ago` to sync only images uploaded in the past week. Or you can use `-holding hooves` to keep all your hoof holding images contained to one site (you weirdo).

## Screenshot

![Screenshot](https://github.com/marktaiwan/Philomena-Booru-Sync/blob/master/screenshots/screenshot.png?raw=true)


## Known/Unsolvable issue

- If you are syncing to Twibooru, you *must* run the script on the site itself.

- When downloading files for client-side hashing, the connection will frequently timeout on large videos. When this happens, a list of failed downloads will be included in the report generated at the end.
