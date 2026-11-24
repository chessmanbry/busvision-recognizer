import {findLedRegions} from './ledRegions.js';
self.onmessage = ({data:{pixels,width,height,sideSign}}) => {
  self.postMessage(findLedRegions(pixels,width,height,sideSign));
};
