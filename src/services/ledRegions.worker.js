import {findLedRegions} from './ledRegions.js';
self.onmessage = ({data:{pixels,width,height}}) => {
  self.postMessage(findLedRegions(pixels,width,height));
};
