const _ = require('lodash');
const path = require('path');
const yaml = require('js-yaml');
const toml = require('@iarna/toml');
const fs = require('fs');
const sanityClient = require('@sanity/client');

const projectId = process.env['SANITY_PROJECT_ID'];
const token = process.env['SANITY_DEPLOY_TOKEN'];
const dataset = process.env['SANITY_DATASET'] || 'production';
const ssgType = process.env['SSG_TYPE'];
const preview = !!process.env['PREVIEW'];

const DRAFT_ID_PREFIX = 'drafts.';
const DRAFT_ID_REGEXP = /^drafts\./;

const dataDirMapBySSGType = {
    jekyll: '_data',
    hugo: 'data',
    gatsby: 'src/data'
};

const pagesDirMapBySSGType = {
    jekyll: '',
    hugo: 'content',
    gatsby: 'src/pages'
};

function stackbitPull({projectId, dataset, token, ssgType, preview}) {
    dataset = dataset || 'production';

    const client = sanityClient({
        projectId,
        dataset,
        token
    });

    const query = '*[!(_id in path("_.**"))' + (preview ? '' : ' && !(_id in path("drafts.**"))') + ']';

    console.log(`pulling content from Sanity, projectId: ${projectId}, dataset: ${dataset}`);
    return client.fetch(query).then(entries => {
        console.log(`got ${entries.length} entries from Sanity`);
        if (preview) {
            return overlayDrafts(entries);
        } else {
            return entries;
        }
    }).then((entries) => {
        return filterAndTransformProperties(entries);
    }).then((entries) => {
        console.log('generating file data');
        return createFiles(entries, ssgType);
    }).then(files => {
        console.log('writing files...');
        _.forEach(files, file => {
            const filePath = path.join(__dirname, file.filePath);
            console.log('writing file: ' + filePath);
            fs.writeFileSync(filePath, file.data, 'utf8');
        })
    });
}

function overlayDrafts(documents) {
    const docGroups = _.groupBy(documents, doc => isDraftId(doc._id) ? 'drafts' : 'published');
    const documentsByPureId = _.keyBy(docGroups.published, '_id');
    _.forEach(docGroups.drafts, doc => {
        documentsByPureId[getCanonicalObjectId(doc._id)] = doc;
    });
    return _.values(documentsByPureId);
}

function isDraftId(objectId) {
    return objectId && objectId.startsWith(DRAFT_ID_PREFIX);
}

function getCanonicalObjectId(objectId) {
    return isDraftId(objectId) ? objectId.replace(DRAFT_ID_REGEXP, '') : objectId;
}

function getDraftObjectId(objectId) {
    return isDraftId(objectId) ? objectId : `${DRAFT_ID_PREFIX}${objectId}`;
}

function filterAndTransformProperties(allEntries) {
    const groups = _.groupBy(allEntries, (entry) => {
        const entryType = _.get(entry, '_type');
        return (['sanity.imageAsset', 'sanity.fileAsset'].includes(entryType)) ? 'assets' : 'entries';
    });
    let entries = _.get(groups, 'entries', []);
    const assets = _.get(groups, 'assets', []);
    const entriesById = _.keyBy(entries, '_id');
    const assetsById = _.keyBy(assets, '_id');
    entries = filterRootEntries(entries, _.property('stackbit_model_type'));
    return transformEntries(entries, entriesById, assetsById);
}

function filterRootEntries(entries, modelTypePredicate) {
    const rootModelTypes = ['page', 'data', 'config'];
    return _.filter(entries, entry => _.includes(rootModelTypes, modelTypePredicate(entry)));
}

function transformEntries(entries, entriesById, assetsById) {
    return _.map(entries, entry => {
        return deepMap(entry, (value, fieldPath) => {
            let type = _.get(value, '_type');

            if (type === 'slug' && _.has(value, 'current')) {
                return _.get(value, 'current');
            }

            if (type === 'image' || type === 'file') {
                const assetId = _.get(value, 'asset._ref');
                if (!assetId) {
                    return null;
                }
                const image = _.get(assetsById, assetId);
                return _.get(image, 'url');
            }

            if (type === 'color') {
                return _.get(value, 'hex');
            }

            if (type === 'reference') {
                const refId = _.get(value, '_ref');
                if (!refId) {
                    return null;
                }
                value = _.get(entriesById, refId);
            }

            return transformObject(value, fieldPath);
        });
    });
}

function transformObject(obj, fieldPath) {
    if (!_.isPlainObject(obj)) {
        return obj;
    }
    let fieldNames = _.get(obj, 'stackbit_field_names');
    const isRootEntry = _.isEmpty(fieldPath);
    const omitKeys = ['stackbit_field_names'];
    let mappedFields = _.omitBy(obj, (value, key) => omitKeys.includes(key) || key[0] === '_');
    if (!isRootEntry) {
        mappedFields = _.omit(mappedFields, ['stackbit_model_type']);
    }
    if (fieldNames) {
        fieldNames = JSON.parse(fieldNames);
        mappedFields = _.mapKeys(mappedFields, (value, fieldName) => _.get(fieldNames, fieldName, fieldName));
    }
    return mappedFields;
}

function createFiles(entries, ssgType) {
    // If, for some reason, one of the entries won't have 'stackbit_model_type'
    // the createFile() for that entry will return null, and the compact() will
    // remove it from the array.
    return _.chain(entries)
        .map(entry => createFile(entry, ssgType))
        .compact()
        .value();
}

function createFile(entry, ssgType) {
    const stackbitModelType = _.get(entry, 'stackbit_model_type');
    if (stackbitModelType === 'page') {
        return createPageFile(entry, ssgType);
    } else if (stackbitModelType === 'data') {
        return createDataFile(entry, ssgType);
    } else if (stackbitModelType === 'config') {
        return createConfigFile(entry);
    } else {
        return null;
    }
}

function createPageFile(page, ssgType) {
    const filePath = getPageFilePath(page, ssgType);
    const data = _.omit(page, ['stackbit_model_type', 'stackbit_url_path', 'stackbit_dir', 'stackbit_file_ext']);
    return {
        filePath: filePath,
        data: convertDataByFilePath(data, filePath)
    };
}

function createDataFile(dataFile, ssgType) {
    const filePath = getDataFilePath(dataFile, ssgType);
    // objects of 'data' type might not have filePath if the model has 'folder' property
    // but they will be resolved as nested object in their parent objects
    if (!filePath) {
        return null;
    }
    const data = _.omit(dataFile, ['stackbit_model_type', 'stackbit_file_path', 'stackbit_dir']);
    return {
        filePath: filePath,
        data: convertDataByFilePath(data, filePath)
    };
}

function createConfigFile(configData) {
    const filePath = configData.stackbit_file_path;
    const data = _.omit(configData, ['stackbit_model_type', 'stackbit_file_path']);
    return {
        filePath: filePath,
        data: convertDataByFilePath(data, filePath)
    };
}

function getPageFilePath(page, ssgType) {
    let url = page.stackbit_url_path;

    // Remove the leading "/" to prevent bugs in url concatenation
    if (_.startsWith(url, '/')) {
        url = url.substring(1);
    }

    // If url is an empty string or ends with "/", append "index" to url
    if (url === '' || _.endsWith(url, '/')) {
        url += 'index';
    }

    // update url for specific SSGs
    if (ssgType === 'jekyll') {
        // If url starts with "posts/" or "_posts/", replace with "_posts/" and append timestamp to file name
        if (/^_?posts\//.test(url)) {
            let urlParts = url.split('/');
            let postFilePath = urlParts[1];
            if (!/^\d{4}-\d{2}-\d{2}/.test(postFilePath)) {
                let dateISOStr = new Date(page.date).toISOString().substr(0, 10);
                postFilePath = dateISOStr + '-' + postFilePath;
            }
            postFilePath = postFilePath.replace(/_+/g, '-');
            url = '_posts/' + postFilePath;
        }
    } else if (ssgType === 'hugo') {
        // If url is "index" or ends with "/index", replace "index" with "_index"
        if (url === 'index' || _.endsWith(url, '/index')) {
            url = url.replace(/index$/, '_index');
        }
    }

    let pagesDir = '';
    if (_.has(page, 'stackbit_dir')) {
        pagesDir = _.get(page, 'stackbit_dir');
    } else if (_.has(pagesDirMapBySSGType, ssgType)) {
        pagesDir = _.get(pagesDirMapBySSGType, ssgType);
    }

    // append page folder to url
    url = path.join(pagesDir, url);

    const ext = page['stackbit_file_ext'] || '.md';

    // Finally, append ext to the url
    return url + ext;
}

function getDataFilePath(dataFile, ssgType) {
    let filePath = _.get(dataFile, 'stackbit_file_path', null);
    let dataDir;
    if (_.has(dataFile, 'stackbit_dir')) {
        dataDir = _.get(dataFile, 'stackbit_dir', null);
    } else {
        dataDir = _.get(dataDirMapBySSGType, ssgType, null);
    }
    // for backward compatibility check if dataDir isn't already included
    if (filePath && dataDir && !_.startsWith(filePath, dataDir)) {
        filePath = path.join(dataDir, filePath);
    }
    return filePath;
}

function convertDataByFilePath(data, filePath) {
    const extension = path.extname(filePath).substring(1);
    let result;
    switch (extension) {
        case 'yml':
        case 'yaml':
            result = yaml.safeDump(data, {noRefs: true});
            break;
        case 'toml':
            result = toml.stringify(data);
            break;
        case 'json':
            result = JSON.stringify(data);
            break;
        case 'md':
            result = markdownStringify(data);
            break;
        case 'html':
            result = _.get(data, 'content', '');
            break;
        default:
            throw new Error(`Build error, data file '${filePath}' could not be created, extension '${extension}' is not supported`);
    }
    return result;
}

function markdownStringify(data) {
    const frontmatterData = _.omit(data, ['content']);
    const frontmatter = yaml.safeDump(frontmatterData, {noRefs: true});
    const content = _.get(data, 'content', '');
    // yaml.safeDump adds new line at the end of its output
    return `---\n${frontmatter}---\n${content}`;
}

function deepMap(object, iteratee, options) {
    const context = _.get(options, 'context');
    const iterateCollections = _.get(options, 'iterateCollections', true);
    const iteratePrimitives = _.get(options, 'iteratePrimitives', true);

    function _mapDeep(value, keyPath, mappedValueStack) {
        let invokeIteratee = (_.isPlainObject(value) || _.isArray(value)) ? iterateCollections : iteratePrimitives;
        if (invokeIteratee) {
            value = iteratee.call(context, value, keyPath, mappedValueStack, object);
        }
        if (_.isPlainObject(value)) {
            value = _.mapValues(value, (val, key) => {
                return _mapDeep(val, _.concat(keyPath, key), _.concat(mappedValueStack, value));
            });
        } else if (_.isArray(value)) {
            value = _.map(value, (val, key) => {
                return _mapDeep(val, _.concat(keyPath, key), _.concat(mappedValueStack, value));
            });
        }
        return value;
    }

    return _mapDeep(object, [], []);
}

stackbitPull({projectId, dataset, token, ssgType, preview}).catch(err => {
    console.error('failed to pull content from Sanity', err);
    process.exit(1);
});
