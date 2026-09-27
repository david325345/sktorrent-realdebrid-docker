// Konfigurační stránka. cfg = předvyplnění při otevření přes /<token>/configure
function configPage(cfg){
    const pre=cfg?{ rd:cfg.rdToken, tb:cfg.tbKey, tmdb:cfg.tmdbKey, uid:cfg.sktUid, pass:cfg.sktPass, search:cfg.sktSearch }:null;
    const preJson=JSON.stringify(pre).replace(/</g,"\\u003c");
    return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SKTorrent | Stremio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#1a1a3e,#24243e);color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.c{background:rgba(30,30,60,.85);backdrop-filter:blur(20px);border-radius:20px;padding:40px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}
@media(max-width:480px){.c{padding:24px 16px}}
h1{font-size:26px;background:linear-gradient(to right,#fff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}
.sub{text-align:center;color:#9ca3af;font-size:13px;margin-bottom:24px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 3px}.b-rd{background:#059669;color:#fff}.b-tb{background:#f59e0b;color:#111}.b-sk{background:#dc2626;color:#fff}.b-tm{background:#01b4e4;color:#fff}
.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:12px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.5;color:#c4b5fd}
label{display:block;margin-bottom:6px;font-size:14px;color:#d1d5db;font-weight:500}
input[type=text],input[type=password]{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;margin-bottom:16px}input:focus{border-color:#8b5cf6}
.opt{font-size:12px;color:#9ca3af;margin:-10px 0 16px;line-height:1.4}.opt a{color:#a78bfa}
.sep{border:none;border-top:1px solid rgba(255,255,255,.08);margin:20px 0}
.sec{font-size:16px;font-weight:600;margin-bottom:12px;color:#c4b5fd}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn{width:100%;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px;color:#fff;transition:all .2s}
.bv{background:linear-gradient(135deg,#059669,#10b981)}.bi{background:linear-gradient(135deg,#7c3aed,#8b5cf6);display:none}.bs{background:linear-gradient(135deg,#dc2626,#ef4444)}.btn:hover{opacity:.9;transform:translateY(-1px)}
.st{text-align:center;margin:12px 0;font-size:14px;min-height:20px;white-space:pre-line}.ok{color:#34d399}.er{color:#f87171}.lo{color:#fbbf24}
.url{background:rgba(0,0,0,.4);border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-family:monospace;font-size:12px;color:#a78bfa;display:none}
.cp{display:inline-block;padding:4px 12px;font-size:12px;background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4);color:#c4b5fd;border-radius:6px;cursor:pointer;margin-top:8px}
.ft{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:#d1d5db}.ft div::before{content:"✓ ";color:#34d399}
</style></head><body>
<div class="c">
<h1>SKTorrent</h1>
<div class="sub">Stremio Addon <span class="badge b-sk">SKT</span><span class="badge b-rd">RD</span><span class="badge b-tb">TorBox</span><span class="badge b-tm">TMDB</span></div>
<div class="info">Prohledává <b>sktorrent.eu</b> a streamuje přes <b>Real-Debrid</b> a/nebo <b>TorBox</b>.<br>Vyplň aspoň jeden z nich. S oběma se každý torrent zobrazí dvakrát (jednou pro každou službu).</div>

<div class="sec">🔑 Real-Debrid</div>
<label for="rd">API Token</label>
<input type="text" id="rd" placeholder="Vlož RD API token..." autocomplete="off">
<div class="opt">Získej na <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener">real-debrid.com/apitoken</a></div>

<div class="sec">📦 TorBox</div>
<label for="tb">API Key</label>
<input type="text" id="tb" placeholder="Vlož TorBox API key..." autocomplete="off">
<div class="opt">Získej na <a href="https://torbox.app/settings" target="_blank" rel="noopener">torbox.app/settings</a>. Torrenty v cache TorBoxu mají ve výpisu ⚡.</div>

<hr class="sep">
<div class="sec">🎬 TMDB (volitelné)</div>
<label for="tmdb">API Key</label>
<input type="text" id="tmdb" placeholder="Vlož TMDB API key..." autocomplete="off">
<div class="opt">Bez TMDB se hledá jen anglicky. S TMDB i česky/slovensky.<br>Získej na <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a></div>

<hr class="sep">
<div class="sec">🔓 SKTorrent účet (volitelné)</div>
<div class="opt" style="margin-top:0;margin-bottom:12px">⚠️ Bez účtu najde addon méně výsledků. S účtem na sktorrent.eu se zobrazí i omezený obsah.</div>
<div class="row">
<div><label for="skt_user">Jméno</label><input type="text" id="skt_user" placeholder="SKT jméno..." autocomplete="username"></div>
<div><label for="skt_pass">Heslo</label><input type="password" id="skt_pass" placeholder="SKT heslo..." autocomplete="current-password"></div>
</div>
<button class="btn bs" id="skt_btn">🔓 Přihlásit na SKTorrent</button>
<div class="st" id="skt_st"></div>

<hr class="sep">
<div class="sec">🔍 Přímé hledání na SKT</div>
<label style="cursor:pointer;display:flex;align-items:center;gap:10px;margin-bottom:16px">
<input type="checkbox" id="skt_search" style="accent-color:#8b5cf6;transform:scale(1.4)">
<span style="font-size:14px;font-weight:400">Povolit hledání přímo na SKTorrent</span>
</label>
<div class="opt" style="margin-top:-8px">Zobrazí výsledky ze SKTorrent přímo ve Stremio vyhledávání.</div>

<hr class="sep">
<button class="btn bv" id="verify_btn">🔑 Ověřit a nainstalovat</button>
<div class="st" id="s"></div>
<button class="btn bi" id="ib">📦 Nainstalovat do Stremio</button>
<div class="url" id="u"><div id="u_text"></div><span class="cp" id="cp">📋 Kopírovat URL</span></div>
<div class="ft"><div>CZ/SK torrenty</div><div>Real-Debrid + TorBox</div><div>TMDB CZ/SK názvy</div><div>SKT přihlášení</div><div>Přímé hledání SKT</div><div>Auto výběr epizod</div></div>
</div>
<script>
var PRE=${preJson};
var B=location.origin;
var sktUid='',sktPass='';
function $(id){return document.getElementById(id)}
function setSt(el,cls,txt){el.className='st '+cls;el.textContent=txt}

if(PRE){
    $('rd').value=PRE.rd||'';$('tb').value=PRE.tb||'';$('tmdb').value=PRE.tmdb||'';
    $('skt_search').checked=!!PRE.search;
    if(PRE.uid&&PRE.pass){sktUid=PRE.uid;sktPass=PRE.pass;$('skt_btn').textContent='✅ SKT přihlášení zachováno';}
}

$('skt_btn').onclick=async function(){
    var user=$('skt_user').value.trim(),pass=$('skt_pass').value.trim(),st=$('skt_st');
    if(!user||!pass){setSt(st,'er','❌ Zadej jméno a heslo');return}
    setSt(st,'lo','⏳ Přihlašuji...');
    try{
        var r=await(await fetch(B+'/api/skt-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:pass})})).json();
        if(r.success){sktUid=r.uid;sktPass=r.pass;setSt(st,'ok','✅ Přihlášeno na SKTorrent');$('skt_btn').textContent='✅ SKT přihlášeno'}
        else setSt(st,'er','❌ '+(r.error||'Přihlášení selhalo'));
    }catch(e){setSt(st,'er','❌ Chyba: '+e.message)}
};

function getToken(rdOk,tbOk){
    var rd=rdOk?$('rd').value.trim():'',tb=tbOk?$('tb').value.trim():'';
    return [rd,$('tmdb').value.trim(),sktUid||'',sktPass||'',$('skt_search').checked?'1':'0',tb].join('--');
}
var TOKEN='';
function manifestUrl(){return B+'/'+TOKEN+'/manifest.json'}

$('verify_btn').onclick=async function(){
    var rd=$('rd').value.trim(),tb=$('tb').value.trim(),s=$('s');
    $('ib').style.display='none';$('u').style.display='none';
    if(!rd&&!tb){setSt(s,'er','❌ Zadej RD token nebo TorBox klíč');return}
    setSt(s,'lo','⏳ Ověřuji...');
    try{
        var r=await(await fetch(B+'/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rd:rd,tb:tb})})).json();
        var lines=[],rdOk=false,tbOk=false,bad=false;
        if(rd){ if(r.rd&&r.rd.success){rdOk=true;lines.push('✅ RD: '+r.rd.username+' ('+r.rd.type+') do '+new Date(r.rd.expiration).toLocaleDateString('cs-CZ'))} else {bad=true;lines.push('❌ Neplatný RD token')} }
        if(tb){ if(r.tb&&r.tb.success){tbOk=true;lines.push('✅ TorBox: '+r.tb.plan+(r.tb.expires?' do '+new Date(r.tb.expires).toLocaleDateString('cs-CZ'):''))} else {bad=true;lines.push('❌ Neplatný TorBox klíč')} }
        if(!rdOk&&!tbOk){setSt(s,'er',lines.join('\\n'));return}
        var extra=[];
        if($('tmdb').value.trim())extra.push('TMDB');if(sktUid)extra.push('SKT účet');if($('skt_search').checked)extra.push('Hledání');
        if(extra.length)lines.push('+ '+extra.join(', '));
        if(bad)lines.push('⚠️ Neplatný klíč nebude v URL');
        setSt(s,bad?'lo':'ok',lines.join('\\n'));
        TOKEN=getToken(rdOk,tbOk);
        $('u_text').textContent=manifestUrl();
        $('ib').style.display='block';$('u').style.display='block';
    }catch(e){setSt(s,'er','❌ Chyba: '+e.message)}
};
$('ib').onclick=function(){if(TOKEN)window.location.href='stremio://'+location.host+'/'+TOKEN+'/manifest.json'};
$('cp').onclick=function(){navigator.clipboard.writeText(manifestUrl()).then(function(){var c=$('cp');c.textContent='✅ Zkopírováno';setTimeout(function(){c.textContent='📋 Kopírovat URL'},2000)})};
['rd','tb'].forEach(function(id){$(id).addEventListener('keypress',function(e){if(e.key==='Enter')$('verify_btn').click()})});
</script></body></html>`;
}

module.exports = { configPage };
