import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/runtime.ts';
import { predictColumn } from '../src/madi.ts';

const catalog=readJson<any>('config/madi-aliases.json');
const cfg=readJson<any>('universes/U3_madi_companies.json');
// Keep the unit test hermetic: the reviewed benchmark schema lives in the
// ignored local data directory and is intentionally absent from clean CI.
const target={properties:{
  id:{type:'string',description:'Identifier of the company.'},
  name:{type:'string',description:'Name of the company.'},
  founded:{type:'string',description:'Founding date in ISO 8601 format.'},
  country:{type:'string',description:'Name of the country.'},
  industry:{type:'string',description:'Primary industry.'},
  assets:{type:'integer',description:'Total assets in US$ for 2016.'},
  revenue:{type:'integer',description:'Total revenue in US$ for 2016.'},
}};
const targetNames=Object.keys(target.properties);
const targetTypes=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.type]));
const targetDescriptions=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.description??'']));
const predict=(dataset:string,column:string,description:string,sourceType='string')=>predictColumn(column,description,cfg.conceptPatterns,targetNames,{dataset,sourceType,targetTypes,targetDescriptions,aliasRules:catalog.rules,aliasVersion:catalog.version});

test('A3 uses a frozen, provenance-bearing allowlist of metadata aliases',()=>{
  assert.equal(catalog.frozenBeforeEvaluation,true);
  assert.ok(catalog.version);
  const result=predict('dbpedia','org_name','Official or common name of the company');
  assert.equal(result.target,'name');
  assert.equal(result.rule,'approved_metadata_alias');
  assert.equal(result.aliasProvenance.version,catalog.version);
  assert.equal(result.aliasProvenance.sourceMetadata,'data/dbpedia_metadata.json#org_name');
  assert.equal(result.aliasProvenance.targetSchema,'schemamatching/target_schema.json#/properties/name');
  assert.equal(result.aliasProvenance.term,'https://schema.org/name');
});

test('A3 abstains when source metadata contradicts the approved alias contract',()=>{
  assert.equal(predict('dbpedia','org_name','Company tax identifier').target,null);
  const typeMismatch=predict('dbpedia','sector','Industry or business sector','integer');
  assert.equal(typeMismatch.target,null);
  assert.equal(typeMismatch.rule,'alias_source_type_mismatch');
});

test('A3 reviewed abstentions override broad patterns for ambiguous concepts and missing units',()=>{
  const nation=predict('dbpedia','nation','Country associated with the company');
  assert.equal(nation.target,null);
  assert.equal(nation.rule,'reviewed_metadata_abstention');
  assert.equal(predict('forbes','region','Country or region associated with the company').target,null);
  assert.equal(predict('forbes','business_segment','Business segment or sector classification').target,null);
  assert.equal(predict('dbpedia','total_assets_val','Total assets of the company').target,null);
  assert.equal(predict('forbes','asset_value','Total assets of the company').target,null);
  assert.equal(predict('dbpedia','annual_income','Revenue, sales, or annual income of the company').target,null);
  assert.equal(predict('forbes','sales_figure','Annual sales figure of the company').target,null);
});

test('A3 requires compatible declared types and target-required units/periods on pattern candidates',()=>{
  const typeMismatch=predictColumn('revenue_estimate','Revenue for 2016 in USD',{revenue:'\\brevenue\\b'},targetNames,{sourceType:'string',targetTypes,targetDescriptions});
  assert.equal(typeMismatch.target,null);
  assert.equal(typeMismatch.rule,'metadata_type_mismatch');
  const missingContract=predictColumn('revenue_estimate','Revenue estimate',{revenue:'\\brevenue\\b'},targetNames,{sourceType:'integer',targetTypes,targetDescriptions});
  assert.equal(missingContract.target,null);
  assert.equal(missingContract.rule,'metadata_unit_or_period_missing');
});

test('A3 remains deterministic and abstains for ambiguous unreviewed metadata',()=>{
  const first=predict('dbpedia','country_name','Country name');
  const second=predict('dbpedia','country_name','Country name');
  assert.equal(first.target,null);
  assert.deepEqual(first,second);
  assert.equal(first.rule,'ambiguous_or_unknown_metadata');
  assert.equal(predict('forbes','company','Company name as listed by Forbes').target,'name');
});
