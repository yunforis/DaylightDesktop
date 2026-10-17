import { Router } from 'express';
import { isProductionRuntime } from '../runtime-mode.js';
import { enqueuePlan, requestJobKey } from '../job-service.js';
import { publicJob } from '../job-api.js';
import { listScenarios, updateScenarioNavigation, updateScenarioVisibility, createWorkbench, updateWorkbench, deleteWorkbench, deletePersonalTemplate, savePersonalTemplate, exportWorkbenchTemplate, createItem, updateItem, previewWorkbenchMail, linkMailSource, recordExternalSource, proposeItemPlan, confirmAction, recordReceipt, saveReplyDraft, proposeSchedule, confirmSchedule, draftTemplate, previewWorkbenchUpgrade, applyWorkbenchUpgrade, inspectItemEvidence, replayTemplatePack } from './service.js';

export const scenarioRouter=Router();
scenarioRouter.use((req,res,next)=>req.user ? next() : res.status(401).json({error:'请先登录'}));
const route=fn=>async(req,res,next)=>{try { res.json(await fn(req)); } catch(error) { next(error); }};
scenarioRouter.get('/',route(()=>listScenarios()));
scenarioRouter.patch('/navigation',route(req=>updateScenarioNavigation(req.body)));
scenarioRouter.patch('/navigation/visibility',route(req=>updateScenarioVisibility(req.body)));
scenarioRouter.post('/templates/import',route(req=>savePersonalTemplate(req.body)));
scenarioRouter.post('/templates/draft',route(req=>draftTemplate(req.body)));
scenarioRouter.post('/templates/replay',route(req=>replayTemplatePack(req.body)));
scenarioRouter.post('/workbenches',route(req=>createWorkbench(req.body)));
scenarioRouter.patch('/workbenches/:id',route(req=>updateWorkbench(req.params.id,req.body)));
scenarioRouter.delete('/workbenches/:id',route(req=>deleteWorkbench(req.params.id)));
scenarioRouter.delete('/templates/:id',route(req=>deletePersonalTemplate(req.params.id)));
scenarioRouter.get('/workbenches/:id/template',route(req=>exportWorkbenchTemplate(req.params.id)));
scenarioRouter.get('/workbenches/:id/upgrade',route(req=>previewWorkbenchUpgrade(req.params.id)));
scenarioRouter.post('/workbenches/:id/upgrade',route(req=>applyWorkbenchUpgrade(req.params.id)));
scenarioRouter.post('/workbenches/:id/items',route(req=>createItem(req.params.id,req.body)));
scenarioRouter.patch('/workbenches/:id/items/:itemId',route(req=>updateItem(req.params.id,req.params.itemId,req.body)));
scenarioRouter.get('/workbenches/:id/mail-preview',route(req=>previewWorkbenchMail(req.params.id)));
scenarioRouter.post('/workbenches/:id/sources',route(req=>linkMailSource(req.params.id,req.body)));
scenarioRouter.post('/workbenches/:id/items/:itemId/external-sources',route(req=>recordExternalSource(req.params.id,req.params.itemId,req.body)));
scenarioRouter.post('/workbenches/:id/items/:itemId/plan',async(req,res,next)=>{
  try {
    if (!isProductionRuntime()) return res.json(await proposeItemPlan(req.params.id,req.params.itemId,{useModel:Boolean(req.body?.useModel)}));
    const {job}=await enqueuePlan({ownerId:req.user.id,workbenchId:req.params.id,itemId:req.params.itemId,useModel:req.body?.useModel,
      idempotencyKey:requestJobKey(req.get('Idempotency-Key'),`plan:${req.params.id}:${req.params.itemId}`)});
    res.status(202).json({job:publicJob(job)});
  } catch(error) { next(error); }
});
scenarioRouter.get('/workbenches/:id/items/:itemId/evidence',route(req=>inspectItemEvidence(req.params.id,req.params.itemId)));
scenarioRouter.post('/workbenches/:id/items/:itemId/reply-draft',route(req=>saveReplyDraft(req.params.id,req.params.itemId,req.body)));
scenarioRouter.post('/workbenches/:id/actions/:actionId/confirm',route(req=>confirmAction(req.params.id,req.params.actionId)));
scenarioRouter.post('/workbenches/:id/receipts',route(req=>recordReceipt(req.params.id,req.body)));
scenarioRouter.post('/workbenches/:id/items/:itemId/schedule',route(req=>proposeSchedule(req.params.id,req.params.itemId,req.body)));
scenarioRouter.post('/workbenches/:id/actions/:actionId/schedule',route(req=>confirmSchedule(req.params.id,req.params.actionId,req.body)));
