import {libraryAssets} from './ual-library-assets.js';
const assets={...libraryAssets,
 'ual1-Crawl_Bwd_Loop-frames.json':new URL('../../assets/ual-crawl-bwd/ual1-Crawl_Bwd_Loop-frames.json',import.meta.url),
 'ual1-Crawl_Bwd_Loop.json':new URL('../../assets/ual-crawl-bwd/ual1-Crawl_Bwd_Loop.json',import.meta.url),
 'ual1-Crawl_Bwd_Loop.png':new URL('../../assets/ual-crawl-bwd/ual1-Crawl_Bwd_Loop.png',import.meta.url),
 'ual1-Crawl_Bwd_Loop.webm':new URL('../../assets/ual-crawl-bwd/ual1-Crawl_Bwd_Loop.webm',import.meta.url),
 'ual1-Crawl_Bwd_Loop.mp4':new URL('../../assets/ual-crawl-bwd/ual1-Crawl_Bwd_Loop.mp4',import.meta.url),
 'model.json':new URL('../../assets/ual-fit/model.json',import.meta.url),
 'ual1-Crouch_Fwd_Loop-frames.json':new URL('../../assets/ual-fit/ual1-Crouch_Fwd_Loop-frames.json',import.meta.url),
 'ual1-Crouch_Fwd_Loop.json':new URL('../../assets/ual-fit/ual1-Crouch_Fwd_Loop.json',import.meta.url),
 'ual1-Crouch_Fwd_Loop.png':new URL('../../assets/ual-fit/ual1-Crouch_Fwd_Loop.png',import.meta.url),
 'ual1-Crouch_Fwd_Loop.webm':new URL('../../assets/ual-fit/ual1-Crouch_Fwd_Loop.webm',import.meta.url),
 'ual1-Crouch_Fwd_Loop.mp4':new URL('../../assets/ual-fit/ual1-Crouch_Fwd_Loop.mp4',import.meta.url),
};
export function assetURL(path){const key=path.split('/').at(-1);if(!assets[key])throw Error('Unknown fitted UAL asset: '+key);return assets[key].href;}
