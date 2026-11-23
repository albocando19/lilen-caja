// Facturación electrónica ARCA (Factura C, monotributo) para la caja de Lilén Márquez.
// Acciones:
//   { accion: "ultimo" }               -> último número de Factura C autorizado en el punto de venta (no emite nada)
//   { accion: "facturar", venta_id, receptor? } -> emite la Factura C de esa venta y guarda CAE y número
//      receptor (opcional): { nombre, doc_tipo: 96 DNI | 80 CUIT | 86 CUIL, doc_nro, cond_iva: 5 CF | 6 Monotributo | 1 RI | 4 Exento, domicilio? }
//      sin receptor = consumidor final anónimo
import forge from "npm:node-forge@1.3.1";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const CUIT = "27399212729";
const PTO_VTA = 4;
const CBTE_TIPO = 11; // Factura C
const WSAA = "https://wsaa.afip.gov.ar/ws/services/LoginCms";
const WSFE = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const pem = (v: string) => (v.includes("BEGIN") ? v : atob(v.replace(/\s+/g, "")));
const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const tag = (xml: string, t: string) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`)); return m ? m[1] : null; };
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// ---------- WSAA: ticket de acceso ----------
async function ticket(db: ReturnType<typeof admin>) {
  const { data } = await db.from("arca_ta").select("*").eq("servicio", "wsfe").maybeSingle();
  if (data && new Date(data.expira).getTime() - Date.now() > 10 * 60 * 1000) return data;

  const ahora = new Date();
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId><generationTime>${iso(new Date(ahora.getTime() - 10 * 60000))}</generationTime><expirationTime>${iso(new Date(ahora.getTime() + 10 * 60000))}</expirationTime></header><service>wsfe</service></loginTicketRequest>`;

  const cert = forge.pki.certificateFromPem(pem(Deno.env.get("ARCA_CERT")!));
  const key = forge.pki.privateKeyFromPem(pem(Deno.env.get("ARCA_KEY")!));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: ahora },
    ],
  });
  p7.sign();
  const cms = forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());

  const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await fetch(WSAA, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' }, body: soap });
  const txt = await r.text();
  const ret = tag(txt, "loginCmsReturn");
  if (!ret) throw new Error("WSAA: " + (unescape(tag(txt, "faultstring") || txt.slice(0, 300))));
  const ta = unescape(ret);
  const fila = { servicio: "wsfe", token: tag(ta, "token")!, sign: tag(ta, "sign")!, expira: tag(ta, "expirationTime")! };
  await db.from("arca_ta").upsert(fila);
  return fila;
}

// ---------- WSFE ----------
async function wsfe(metodo: string, cuerpo: string, ta: { token: string; sign: string }) {
  const soap = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soap:Body><ar:${metodo}><ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>${cuerpo}</ar:${metodo}></soap:Body></soap:Envelope>`;
  const r = await fetch(WSFE, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"http://ar.gov.afip.dif.FEV1/${metodo}"` }, body: soap });
  return await r.text();
}
const errores = (xml: string) => [...xml.matchAll(/<(?:Err|Obs)>[\s\S]*?<Code>(\d+)<\/Code>[\s\S]*?<Msg>([\s\S]*?)<\/Msg>[\s\S]*?<\/(?:Err|Obs)>/g)].map((m) => `${m[1]}: ${unescape(m[2])}`);

async function ultimo(ta: { token: string; sign: string }) {
  const x = await wsfe("FECompUltimoAutorizado", `<ar:PtoVta>${PTO_VTA}</ar:PtoVta><ar:CbteTipo>${CBTE_TIPO}</ar:CbteTipo>`, ta);
  const nro = tag(x, "CbteNro");
  if (nro === null) throw new Error("WSFE: " + (errores(x).join(" | ") || unescape(tag(x, "faultstring") || x.slice(0, 300))));
  return Number(nro);
}

// Valida y normaliza los datos del cliente. Devuelve null si es anónimo.
const COND = { 5: "Consumidor Final", 6: "Responsable Monotributo", 1: "IVA Responsable Inscripto", 4: "IVA Sujeto Exento" } as Record<number, string>;
function cuitOk(n: string) {
  if (!/^\d{11}$/.test(n)) return false;
  const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = m.reduce((a, k, i) => a + k * Number(n[i]), 0);
  let dv = 11 - (s % 11); if (dv === 11) dv = 0; if (dv === 10) dv = 9;
  return dv === Number(n[10]);
}
function receptor(r: any) {
  if (!r) return null;
  const nombre = String(r.nombre || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const doc_tipo = Number(r.doc_tipo), doc_nro = String(r.doc_nro || "").replace(/\D/g, "");
  const cond_iva = Number(r.cond_iva || 5);
  const domicilio = String(r.domicilio || "").trim().slice(0, 150) || null;
  if (!nombre) throw new Error("Falta el nombre del cliente");
  if (![96, 80, 86].includes(doc_tipo)) throw new Error("Tipo de documento inválido");
  if (!COND[cond_iva]) throw new Error("Condición frente al IVA inválida");
  if (doc_tipo === 96 && !/^\d{7,8}$/.test(doc_nro)) throw new Error("El DNI tiene que tener 7 u 8 números");
  if (doc_tipo !== 96 && !cuitOk(doc_nro)) throw new Error("El CUIT/CUIL no es válido (revisá los 11 números)");
  if (cond_iva !== 5 && doc_tipo !== 80) throw new Error("Para esa condición frente al IVA hace falta el CUIT");
  return { nombre, doc_tipo, doc_nro, cond_iva, cond_iva_txt: COND[cond_iva], domicilio };
}

const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); // fecha en Argentina (UTC-3)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const db = admin();

    if (body.accion === "ultimo") {
      const ta = await ticket(db);
      return json({ ok: true, punto_venta: PTO_VTA, tipo: "Factura C", ultimo: await ultimo(ta) });
    }

    if (body.accion === "facturar") {
      // Solo usuarios logueados de la caja
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await db.auth.getUser(jwt);
      if (!u?.user) return json({ ok: false, error: "No autorizado" }, 401);

      const { data: v, error } = await db.from("ventas").select("*").eq("id", body.venta_id).maybeSingle();
      if (error || !v) return json({ ok: false, error: "No encontré la venta" }, 404);
      if (v.anulada) return json({ ok: false, error: "La venta está anulada" }, 400);
      if (v.factura_cae) return json({ ok: true, ya: true, venta: v });
      let rec;
      try { rec = receptor(body.receptor); } catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }

      const ta = await ticket(db);
      // Fecha: la de la venta si tiene hasta 5 días; si no, hoy. Nunca antes que la última factura emitida.
      const hoy = fechaAR(new Date());
      const fVenta = fechaAR(new Date(v.fecha));
      const limite = fechaAR(new Date(Date.now() - 5 * 86400000));
      let fecha = fVenta < limite ? hoy : fVenta;
      const { data: ult } = await db.from("ventas").select("factura_fecha").not("factura_nro", "is", null).order("factura_fecha", { ascending: false }).limit(1);
      if (ult?.[0]?.factura_fecha && fecha < ult[0].factura_fecha) fecha = ult[0].factura_fecha;

      const total = Number(v.total).toFixed(2);
      let ultimoErr = "";
      for (let intento = 0; intento < 3; intento++) {
        const nro = (await ultimo(ta)) + 1;
        const x = await wsfe("FECAESolicitar", `<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${PTO_VTA}</ar:PtoVta><ar:CbteTipo>${CBTE_TIPO}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq><ar:FECAEDetRequest><ar:Concepto>1</ar:Concepto><ar:DocTipo>${rec ? rec.doc_tipo : 99}</ar:DocTipo><ar:DocNro>${rec ? rec.doc_nro : 0}</ar:DocNro><ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${fecha.replace(/-/g, "")}</ar:CbteFch><ar:ImpTotal>${total}</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc><ar:ImpNeto>${total}</ar:ImpNeto><ar:ImpOpEx>0</ar:ImpOpEx><ar:ImpTrib>0</ar:ImpTrib><ar:ImpIVA>0</ar:ImpIVA><ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${rec ? rec.cond_iva : 5}</ar:CondicionIVAReceptorId></ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`, ta);
        const cae = tag(x, "CAE");
        if (tag(x, "Resultado") === "A" && cae) {
          const vto = tag(x, "CAEFchVto")!;
          const upd = { factura_pv: PTO_VTA, factura_tipo: CBTE_TIPO, factura_nro: nro, factura_fecha: fecha, factura_cae: cae, factura_cae_vto: `${vto.slice(0, 4)}-${vto.slice(4, 6)}-${vto.slice(6, 8)}`, factura_receptor: rec };
          const { data: g } = await db.from("ventas").update(upd).eq("id", v.id).select().single();
          return json({ ok: true, venta: g || { ...v, ...upd } });
        }
        ultimoErr = errores(x).join(" | ") || unescape(tag(x, "faultstring") || x.slice(0, 300));
        if (!/10016/.test(ultimoErr)) break; // 10016 = número ya usado (otra caja facturó al mismo tiempo): reintenta
      }
      return json({ ok: false, error: "ARCA rechazó la factura: " + ultimoErr }, 400);
    }

    return json({ ok: false, error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
