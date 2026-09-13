(function(root){
'use strict';
const presets=['247','248','258','358','357','347'];
const ratios=p=>p.split('').map(Number);
const diameter=(set,i)=>set.parentDiameter*ratios(set.preset)[i]/ratios(set.preset)[2];
function changePreset(set,p){if(!presets.includes(p))throw Error('Unknown preset');set.preset=p;}
function resize(set,i,d){if(!Number.isFinite(d)||d<=0)throw Error('Diameter must be positive');set.parentDiameter=d*ratios(set.preset)[2]/ratios(set.preset)[i];}
function validate(doc){
 if(!doc||doc.schema!=='project-adam-circle-measurements/v1'||!Array.isArray(doc.sets))throw Error('Unsupported circle measurement file');
 if(typeof doc.name!=='string'||doc.name.length>500)throw Error('Invalid measurement name');
 if(doc.sets.length>200)throw Error('Too many sets');
 const ids=new Set();for(const s of doc.sets){if(!s||typeof s.id!=='string'||ids.has(s.id)||!presets.includes(s.preset)||!Number.isFinite(s.parentDiameter)||s.parentDiameter<=0||!Array.isArray(s.centers)||s.centers.length!==3||!s.centers.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y))||typeof s.name!=='string')throw Error('Invalid circle set');if((s.success!==undefined&&typeof s.success!=='boolean')||(s.locked!==undefined&&typeof s.locked!=='boolean')||(s.notes!==undefined&&typeof s.notes!=='string'))throw Error('Invalid set flags or notes');ids.add(s.id);}
 if(doc.image&&(!Number.isInteger(doc.image.width)||doc.image.width<=0||!Number.isInteger(doc.image.height)||doc.image.height<=0||typeof doc.image.dataUrl!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(doc.image.dataUrl)))throw Error('Invalid image');
 return doc;
}
root.CircleGeometry={presets,ratios,diameter,changePreset,resize,validate};
if(typeof module!=='undefined')module.exports=root.CircleGeometry;
})(typeof window!=='undefined'?window:globalThis);
