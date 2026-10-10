const updateAccountPanel=()=>{
  const form=document.querySelector('#loginForm');
  if(!form)return;
  const panel=form.closest('.panel');
  if(panel){panel.innerHTML='<h2>Streamlet Account</h2><p class="muted">Synchronizáciu účtu pridáme cez bezpečný device-code flow. Táto verzia zatiaľ uchováva knižnicu a moduly lokálne v Safari.</p>'}
};
new MutationObserver(updateAccountPanel).observe(document.documentElement,{childList:true,subtree:true});
updateAccountPanel();
