// Adaptado de emissor-nfse-nacional (c) Gabriel Buzzi Venturi, licença MIT. https://github.com/gabrielbuzziv/emissor-nfse-nacional
// Fala com os servidores do Sistema Nacional NFS-e. Eles pedem o certificado do cliente por renegociação TLS, que o
// cliente https do Node faz sozinho.
import https from 'node:https'
import { gunzipSync } from 'node:zlib'
import type { Certificado } from './certificado'

const TEMPO_LIMITE_MS = 40_000

export type Resposta = { status: number; tipo: string; json: Record<string, unknown> }

/** JSON do governo, com cada campo `*XmlGZipB64` também devolvido aberto como `*Xml`. */
export const abrirJson = (buffer: Buffer): Record<string, unknown> => {
  const texto = buffer.toString('utf8')
  try {
    const json = JSON.parse(texto) as Record<string, unknown>
    for (const [chave, valor] of Object.entries(json)) {
      if (chave.endsWith('XmlGZipB64') && typeof valor === 'string') json[chave.replace('GZipB64', '')] = gunzipSync(Buffer.from(valor, 'base64')).toString('utf8')
    }
    return json
  } catch {
    return { bruto: texto.slice(0, 4000) }
  }
}

export const chamar = (cert: Certificado, host: string, metodo: string, caminho: string, corpo?: unknown): Promise<Resposta> =>
  new Promise((resolve, reject) => {
    const payload = corpo === undefined ? undefined : JSON.stringify(corpo)
    const req = https.request(
      {
        host,
        path: caminho,
        method: metodo,
        key: cert.chavePem,
        cert: cert.cadeiaPem,
        timeout: TEMPO_LIMITE_MS,
        headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        const partes: Buffer[] = []
        res.on('data', (p: Buffer) => partes.push(p))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, tipo: String(res.headers['content-type'] ?? ''), json: abrirJson(Buffer.concat(partes)) }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('o governo não respondeu a tempo')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })

export interface ErroGoverno {
  codigo: string
  mensagem: string
  complemento?: string
}

export const errosDoGoverno = (r: Resposta): ErroGoverno[] => {
  const lista = (r.json.erros ?? r.json.Erros ?? r.json.erro ?? []) as Array<Record<string, unknown>> | Record<string, unknown>
  const erros = (Array.isArray(lista) ? lista : [lista]).map((e) => ({
    codigo: String(e.Codigo ?? e.codigo ?? ''),
    mensagem: String(e.Descricao ?? e.descricao ?? e.Mensagem ?? e.mensagem ?? ''),
    ...(e.Complemento || e.complemento ? { complemento: String(e.Complemento ?? e.complemento) } : {}),
  }))
  if (erros.length && erros.some((e) => e.codigo || e.mensagem)) return erros
  return [{ codigo: `HTTP ${r.status}`, mensagem: JSON.stringify(r.json).slice(0, 500) }]
}
