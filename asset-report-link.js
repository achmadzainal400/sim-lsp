/* SIM-LSP 1.6.3 — tautan eksplisit antara laporan gangguan dan aset. */
(function(){
  function formRelatedValue(form){
    var field=form&&form.elements&&form.elements.namedItem("relatedAssetId");
    return field?String(field.value||""):"";
  }
  function assertRelatedAsset(form){
    var category=form&&form.elements&&form.elements.namedItem("category");
    var selected=formRelatedValue(form);
    if(!selected||!category||!isAssetLinkedReportCategory(category.value))return true;
    var asset=db.assets.find(function(row){return String(row.id)===selected;});
    if(asset)return true;
    toast("Aset terkait tidak ditemukan. Muat ulang daftar aset lalu pilih kembali.");
    return false;
  }
  function refreshRelated(form){
    if(form&&form.id==="reportForm")refreshRelatedAssetField(form);
    if(form&&form.id==="editReportForm")refreshRelatedAssetField(form);
  }
  var renderCreateBase=renderCreate;
  renderCreate=function(){
    var html=renderCreateBase();
    var draft=readReportDraft();
    var field=relatedAssetFieldHtml("relatedAssetId",draft.relatedAssetId||"",draft.location||"",draft.object||"",!isAssetLinkedReportCategory(draft.category));
    return html.replace('<div class="field full" id="procurementFields"',field+'<div class="field full" id="procurementFields"');
  };
  var ensureReportAssetBase=ensureReportAsset;
  var creatingRelatedAssetId="";
  ensureReportAsset=function(report){
    if(creatingRelatedAssetId&&!report.relatedAssetId)report.relatedAssetId=creatingRelatedAssetId;
    return ensureReportAssetBase(report);
  };
  var createReportBase=createReport;
  createReport=async function(form){
    if(!assertRelatedAsset(form))return;
    creatingRelatedAssetId=formRelatedValue(form);
    try{return await createReportBase(form);}finally{creatingRelatedAssetId="";}
  };
  var adminEditFormBase=adminEditForm;
  adminEditForm=function(report){
    var html=adminEditFormBase(report);
    if(!html)return html;
    var field=relatedAssetFieldHtml("editRelatedAssetId",report.relatedAssetId||"",report.location||"",report.object||"",!isAssetLinkedReportCategory(report.category));
    field=field.replace('id="editRelatedAssetId" name="relatedAssetId"','id="editRelatedAssetId" name="relatedAssetId"');
    return html.replace('<div class="field full"><label>Uraian laporan</label>',field+'<div class="field full"><label>Uraian laporan</label>');
  };
  var saveReportEditsBase=saveReportEdits;
  saveReportEdits=function(form){
    if(!assertRelatedAsset(form))return;
    var report=getReport(form.getAttribute("data-id"));
    if(!report)return;
    var next=formRelatedValue(form),prior=String(report.relatedAssetId||"");
    if(next===prior)return saveReportEditsBase(form);
    var selected=next?db.assets.find(function(asset){return String(asset.id)===next;}):null;
    var priorReport=JSON.parse(JSON.stringify(report));
    report.relatedAssetId=next;
    activity(report,next?"Aset terkait ditetapkan menjadi "+(selected&&selected.name||"aset terpilih")+".":"Tautan aset terkait dilepas.",true);
    saveReportEditsBase(form);
    if(!saveDb()){
      Object.keys(report).forEach(function(key){delete report[key];});
      Object.assign(report,priorReport);
      return;
    }
    toast(next?"Aset terkait berhasil ditautkan ke laporan.":"Tautan aset terkait dilepas.");
    refreshDetail();
  };
  var renderDetailBase=renderDetail;
  renderDetail=function(report){
    var html=renderDetailBase(report),asset=relatedAssetForReport(report);
    if(!asset)return html;
    var card='<div class="detail-item related-asset-detail"><small>Aset terkait</small><strong>'+esc(asset.name||"Aset tanpa nama")+'</strong><span>'+esc(asset.area||"Area belum dicatat")+' · '+esc(assetDateLabel(asset.acquisitionDate))+' · '+esc(assetStatus(asset.status))+'</span></div>';
    return html.replace('</div><div class="divider"></div><div class="section-title">Foto bukti</div>',card+'</div><div class="divider"></div><div class="section-title">Foto bukti</div>');
  };
  var deleteAssetBase=deleteAsset;
  deleteAsset=function(assetId){
    var linked=db.reports.filter(function(report){return String(report.relatedAssetId||"")===String(assetId);});
    if(linked.length){
      toast("Aset ini masih ditautkan ke "+linked.length+" laporan. Lepaskan atau pilih aset lain pada tiket terlebih dahulu.");
      return;
    }
    return deleteAssetBase(assetId);
  };
  document.getElementById("content").addEventListener("input",function(event){
    var form=event.target&&event.target.form;
    if(form&&(form.id==="reportForm"||form.id==="editReportForm")&&(event.target.name==="location"||event.target.name==="object"))refreshRelated(form);
  });
  document.getElementById("content").addEventListener("change",function(event){
    var form=event.target&&event.target.form;
    if(form&&form.id==="reportForm"&&event.target.name==="category")refreshRelated(form);
  });
  document.getElementById("content").addEventListener("reset",function(event){
    if(event.target&&event.target.id==="reportForm")window.setTimeout(function(){refreshRelated(event.target);},0);
  });
  document.getElementById("modalBody").addEventListener("input",function(event){
    var form=event.target&&event.target.form;
    if(form&&form.id==="editReportForm"&&(event.target.name==="location"||event.target.name==="object"))refreshRelated(form);
  });
  document.getElementById("modalBody").addEventListener("change",function(event){
    var form=event.target&&event.target.form;
    if(form&&form.id==="editReportForm"&&event.target.name==="category")refreshRelated(form);
  });
  var saveDraftBase=saveReportDraft;
  saveReportDraft=function(form){
    saveDraftBase(form);
    if(!form||form.id!=="reportForm")return;
    try{
      var raw=JSON.parse(sessionStorage.getItem(REPORT_DRAFT_KEY)||"{}"),value=formRelatedValue(form);
      raw.relatedAssetId=value;
      sessionStorage.setItem(REPORT_DRAFT_KEY,JSON.stringify(raw));
    }catch(_){ }
  };
})();
