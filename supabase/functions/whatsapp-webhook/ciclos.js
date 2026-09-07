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
function primerCierreDeCompra(fC,cfg,diaCierre){
  const ancla=(cfg&&typeof cfg==='object'&&cfg.cicloCierre)?aFecha(cfg.cicloCierre):null;
  if(!ancla){
    return fC.getDate()>diaCierre
      ? sumarMesCierre(fC.getFullYear(),fC.getMonth(),diaCierre)
      : cierreEnMes(fC.getFullYear(),fC.getMonth(),diaCierre);
  }
  // El inicio del ciclo es el día siguiente al cierre anterior, así que ese
  // cierre anterior es un dato real y no hay que inferirlo por día del mes.
  const cierreAnterior=cfg.cicloInicio?sumarDias(aFecha(cfg.cicloInicio),-1):null;
  if(cierreAnterior&&fC>cierreAnterior&&fC<=ancla)return ancla; // compra dentro del ciclo vigente
  if(fC>ancla){ // futuro: se asume mensual desde el cierre conocido
    let c=ancla,guarda=0;
    while(c<fC&&guarda++<600)c=sumarMesCierre(c.getFullYear(),c.getMonth(),ancla.getDate());
    return c;
  }
  // Pasado: se retrocede mensualmente desde el cierre anterior conocido.
  const base=cierreAnterior||ancla,dia=base.getDate();
  let anio=base.getFullYear(),mes=base.getMonth(),c=base,guarda=0;
  while(c>=fC&&guarda++<600){
    const p=new Date(anio,mes-1,1);anio=p.getFullYear();mes=p.getMonth();
    const prev=cierreEnMes(anio,mes,dia);
    if(prev<fC)break;
    c=prev;
  }
  return c;
}
function calcularCuotaActual(fechaCompra,diaCierreOCfg,fechaReferencia=null){
  const cfg=(diaCierreOCfg&&typeof diaCierreOCfg==='object')?diaCierreOCfg:null;
  const diaCierre=cfg?cfg.dia:diaCierreOCfg;
  if(!diaCierre)return 0;
  const fC=new Date(fechaCompra+'T00:00:00');
  const ref=fechaReferencia?new Date(fechaReferencia):new Date();
  ref.setHours(0,0,0,0);
  let ev=primerCierreDeCompra(fC,cfg,diaCierre),n=0,guarda=0;
  const dia=ev.getDate();
  while(ev<ref&&guarda++<600){n++;ev=sumarMesCierre(ev.getFullYear(),ev.getMonth(),dia);}
  return n+1;
}

export { diasEnMes, clampDia, aFecha, aISO, sumarDias, sumarMesesFecha, proximoCierreFecha, cicloActual, cierreEnMes, sumarMesCierre, primerCierreDeCompra, calcularCuotaActual };
