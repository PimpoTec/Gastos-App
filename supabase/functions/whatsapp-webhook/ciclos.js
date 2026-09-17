// Lógica de ciclos de tarjeta y numeración de cuotas.
//
// IMPORTANTE: copia literal de las funciones equivalentes de app.html. Las dos
// implementaciones tienen que dar exactamente lo mismo, o los totales del bot
// van a diferir de los de la app (ya pasó tres veces con otros cálculos).
// tests/ciclos.spec.js compara ambas sobre los mismos datos: si tocás una,
// tocá la otra y corré ese test.

function diasEnMes(anio,mes){return new Date(anio,mes+1,0).getDate();}
function clampDia(anio,mes,dia){return Math.min(dia,diasEnMes(anio,mes));}
function aFecha(iso){return iso?new Date(iso+'T00:00:00'):null;}
function aISO(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function sumarDias(d,n){return new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);}
function sumarMesesFecha(d,n){
  const norm=new Date(d.getFullYear(),d.getMonth()+n,1);
  return new Date(norm.getFullYear(),norm.getMonth(),clampDia(norm.getFullYear(),norm.getMonth(),d.getDate()));
}
function proximoCierreFecha(d,dH=new Date()){
  const f=new Date(dH.getFullYear(),dH.getMonth(),clampDia(dH.getFullYear(),dH.getMonth(),d));
  if(dH.getDate()>d){
    const sig=new Date(dH.getFullYear(),dH.getMonth()+1,1);
    return new Date(sig.getFullYear(),sig.getMonth(),clampDia(sig.getFullYear(),sig.getMonth(),d));
  }
  return f;
}
function cicloActual(cfg,dH=new Date()){
  if(!cfg||typeof cfg!=='object')return null;
  let desde=aFecha(cfg.cicloInicio),hasta=aFecha(cfg.cicloCierre);
  if(!desde||!hasta){
    // Config vieja (solo día del mes): se deriva el ciclo actual de ese día.
    if(!cfg.dia)return null;
    hasta=proximoCierreFecha(cfg.dia,dH);
    desde=sumarDias(sumarMesesFecha(hasta,-1),1);
    return{desde,hasta,pendiente:false};
  }
  const hoy=new Date(dH.getFullYear(),dH.getMonth(),dH.getDate());
  let pendiente=false;
  // El cierre ya pasó: avanzar de a un ciclo hasta alcanzar el vigente.
  let guarda=0;
  while(hoy>hasta&&guarda++<60){
    desde=sumarDias(hasta,1);
    hasta=sumarMesesFecha(hasta,1);
    pendiente=true; // la fecha del nuevo cierre es estimada hasta que la confirmen
  }
  return{desde,hasta,pendiente};
}
function cierreEnMes(anio,mes,dia){return new Date(anio,mes,clampDia(anio,mes,dia));}
function sumarMesCierre(anio,mes,diaCierre){
  const norm=new Date(anio,mes+1,1);
  return new Date(norm.getFullYear(),norm.getMonth(),clampDia(norm.getFullYear(),norm.getMonth(),diaCierre));
}
// Todos los cierres reales que conocemos de una tarjeta, de más viejo a más
// nuevo: los que se fueron archivando al confirmar cada cierre, el cierre
// anterior (el día previo al inicio del ciclo vigente) y el cierre actual.
// El banco corre la fecha de cierre por fines de semana y feriados, así que
// "día N de todos los meses" es una suposición falsa: las cuotas hay que
// contarlas contra las fechas que pasaron de verdad.
function cierresConocidos(cfg){
  if(!cfg||typeof cfg!=='object')return[];
  const vistos=new Set(),out=[];
  const agregar=f=>{if(!f||isNaN(f))return;const k=aISO(f);if(vistos.has(k))return;vistos.add(k);out.push(f);};
  (Array.isArray(cfg.historial)?cfg.historial:[]).forEach(iso=>agregar(aFecha(iso)));
  if(cfg.cicloInicio)agregar(sumarDias(aFecha(cfg.cicloInicio),-1));
  if(cfg.cicloCierre)agregar(aFecha(cfg.cicloCierre));
  return out.sort((a,b)=>a-b);
}

// Primer cierre que cubre a una compra. Una compra hecha el mismo día del
// cierre entra en ese resumen.
function primerCierreDeCompra(fC,cfg,diaCierre){
  const conocidos=cierresConocidos(cfg);
  if(!conocidos.length){
    return fC.getDate()>diaCierre
      ? sumarMesCierre(fC.getFullYear(),fC.getMonth(),diaCierre)
      : cierreEnMes(fC.getFullYear(),fC.getMonth(),diaCierre);
  }
  const primero=conocidos[0],ultimo=conocidos[conocidos.length-1];
  if(fC<=primero){
    // Más viejo que todo el historial: se retrocede mes a mes desde el cierre
    // conocido más antiguo. Es una aproximación —no sabemos cuánto se corrió
    // el cierre en esos meses— y mejora sola a medida que se junta historial.
    let c=primero,guarda=0;
    while(guarda++<600){
      const p=new Date(c.getFullYear(),c.getMonth()-1,1);
      const prev=cierreEnMes(p.getFullYear(),p.getMonth(),primero.getDate());
      if(prev<fC)break;
      c=prev;
    }
    return c;
  }
  const cubre=conocidos.find(c=>c>=fC);
  if(cubre)return cubre;
  // Posterior al último cierre conocido: se proyecta con el día configurado,
  // que es lo único que hay para el futuro.
  let c=ultimo,guarda=0;
  while(c<fC&&guarda++<600)c=sumarMesCierre(c.getFullYear(),c.getMonth(),diaCierre||c.getDate());
  return c;
}

function siguienteCierre(cfg,c){
  const conocidos=cierresConocidos(cfg);
  if(conocidos.some(x=>x.getTime()===c.getTime())){
    const prox=conocidos.find(x=>x>c);
    if(prox)return prox;
  }
  // Sin cierres reales a mano se proyecta mensual. El día sale del ancla —el
  // cierre conocido más viejo hacia atrás, el día configurado hacia adelante—
  // y nunca de c.getDate(): un cierre que cayó en febrero viene recortado al
  // 28, y arrastrarlo corre toda la secuencia un día, con lo que deja de
  // coincidir con los cierres del historial y el salto no se dispara.
  const primero=conocidos.length?conocidos[0]:null;
  const ultimo=conocidos.length?conocidos[conocidos.length-1]:null;
  const dia=(ultimo&&c>=ultimo)?((cfg&&cfg.dia)?cfg.dia:c.getDate())
                               :(primero?primero.getDate():c.getDate());
  return sumarMesCierre(c.getFullYear(),c.getMonth(),dia);
}

function calcularCuotaActual(fechaCompra,diaCierreOCfg,fechaReferencia=null){
  const cfg=(diaCierreOCfg&&typeof diaCierreOCfg==='object')?diaCierreOCfg:null;
  const diaCierre=cfg?cfg.dia:diaCierreOCfg;
  if(!diaCierre)return 0;
  const fC=new Date(fechaCompra+'T00:00:00');
  const ref=fechaReferencia?new Date(fechaReferencia):new Date();
  ref.setHours(0,0,0,0);
  let ev=primerCierreDeCompra(fC,cfg,diaCierre),n=0,guarda=0;
  while(ev<ref&&guarda++<600){n++;ev=siguienteCierre(cfg,ev);}
  return n+1;
}

export { diasEnMes, clampDia, aFecha, aISO, sumarDias, sumarMesesFecha, proximoCierreFecha, cicloActual, cierreEnMes, cierresConocidos, sumarMesCierre, primerCierreDeCompra, siguienteCierre, calcularCuotaActual };
