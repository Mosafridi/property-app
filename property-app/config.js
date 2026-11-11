// I'm keeping config this simple on purpose - unlike the movie app, there's no external API
// here, everything lives in my own SQLite database, so the app works fully offline and there's
// no key to leak or manage.
const path = require('path');

module.exports = {
    DB_PATH: path.join(__dirname, "property.db"),
    AREAS_XML_PATH: path.join(__dirname, "data", "dublin-areas.xml"),
    AGENTS_SEED_PATH: path.join(__dirname, "data", "agents-seed.json"),
    LISTINGS_SEED_PATH: path.join(__dirname, "data", "listings-seed.json"),
    // IMAGES_DIR is where the {imageFile} jpgs referenced in listings-seed.json live -
    // seed.js reads the actual bytes from here at seed time and writes them into the
    // image_data BLOB column, the same way the add-listing upload flow does.
    IMAGES_DIR: path.join(__dirname, "data", "images")
};