// Adaptado de emissor-nfse-nacional (c) Gabriel Buzzi Venturi, licença MIT. https://github.com/gabrielbuzziv/emissor-nfse-nacional
// Acréscimos desta versão: endereço do tomador e município da prestação diferente do município do prestador.
/**
 * Monta os documentos do Sistema Nacional NFS-e (DPS e pedido de cancelamento) já em forma canônica, que é assinada
 * como está: sem espaço entre as tags, sem tag autofechada, texto escapado.
 */

export type Ambiente = 'producao' | 'testes'

export interface Emitente {
  cnpj: string
  /** Código IBGE do município do CNPJ (cLocEmi). */
  municipio: string
  /** Só quando a prefeitura cadastrou a empresa no CNC; senão a DPS é recusada (E0120). */
  inscricaoMunicipal?: string
  /** 1 = não optante, 2 = MEI, 3 = ME/EPP. */
  opcaoSimples: '1' | '2' | '3'
  /** Só ME/EPP: 1 = tributos federais e municipal pelo Simples. */
  apuracaoSimples?: '1' | '2' | '3'
  /** Só ME/EPP: alíquota aproximada do Simples (Lei 12.741), ex.: "6.00". */
  aliquotaAproximadaSimples?: string
}

export interface Endereco {
  /** Código IBGE do município do tomador. */
  municipio: string
  cep: string
  logradouro: string
  numero: string
  complemento?: string
  bairro: string
}

export interface Tomador {
  /** CPF (11 dígitos) ou CNPJ (14 dígitos). */
  documento: string
  nome: string
  email?: string
  endereco?: Endereco
}

export interface DadosDps {
  ambiente: Ambiente
  emitente: Emitente
  serie: string
  numero: number
  emitidaEm: Date
  /** Data da prestação, AAAA-MM-DD; nunca depois de `emitidaEm`. */
  competencia: string
  tomador?: Tomador
  /** Município onde o serviço foi prestado (IBGE). Padrão: o do emitente. */
  municipioPrestacao?: string
  /** Código de tributação nacional (cTribNac), 6 dígitos, ex.: "080201". */
  codigoServico: string
  /** Código NBS, 9 dígitos. */
  codigoNbs?: string
  descricao: string
  valorCentavos: number
}

export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse'
const VERSAO_LEIAUTE = '1.01'
export const VERSAO_APLICATIVO = 'minha-nota-fiscal-1'
const TIPO_CNPJ = '2'

export const servidores = {
  producao: { sefin: 'sefin.nfse.gov.br', adn: 'adn.nfse.gov.br' },
  testes: { sefin: 'sefin.producaorestrita.nfse.gov.br', adn: 'adn.producaorestrita.nfse.gov.br' },
} as const satisfies Record<Ambiente, { sefin: string; adn: string }>

const escapar = (texto: string): string => texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const el = (nome: string, conteudo: string | readonly string[]): string =>
  `<${nome}>${typeof conteudo === 'string' ? escapar(conteudo) : conteudo.join('')}</${nome}>`

/** O elemento opcional só quando há conteúdo. */
const opc = (nome: string, conteudo: string | undefined): string => (conteudo ? el(nome, conteudo) : '')

export const digitos = (texto: string): string => texto.replace(/\D/g, '')

/** Hora de Brasília (UTC-3, sem horário de verão desde 2019) no formato do leiaute. */
export const horaBrasilia = (data: Date): string => `${new Date(data.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`

export const dataBrasilia = (data: Date): string => horaBrasilia(data).slice(0, 10)

/** "DPS" + município (7) + tipo de inscrição (1) + CNPJ (14) + série (5) + número (15). */
export const idDps = (emitente: Emitente, serie: string, numero: number): string =>
  `DPS${emitente.municipio}${TIPO_CNPJ}${digitos(emitente.cnpj)}${serie.padStart(5, '0')}${String(numero).padStart(15, '0')}`

const centavosParaDecimal = (centavos: number): string => (centavos / 100).toFixed(2)

const limpar = (texto: string, max: number): string => texto.trim().replace(/\s+/g, ' ').slice(0, max).trim()

const enderecoXml = (e: Endereco): string =>
  el('end', [
    el('endNac', [el('cMun', e.municipio), el('CEP', digitos(e.cep))]),
    el('xLgr', limpar(e.logradouro, 255)),
    el('nro', limpar(e.numero, 60)),
    opc('xCpl', e.complemento ? limpar(e.complemento, 156) : undefined),
    el('xBairro', limpar(e.bairro, 60)),
  ])

const tomadorXml = (t: Tomador): string => {
  const doc = digitos(t.documento)
  return el('toma', [
    el(doc.length === 14 ? 'CNPJ' : 'CPF', doc),
    el('xNome', limpar(t.nome, 150)),
    t.endereco ? enderecoXml(t.endereco) : '',
    opc('email', t.email?.trim().slice(0, 80)),
  ])
}

const totalTributosXml = (e: Emitente): string => {
  // ME/EPP informa a alíquota aproximada do Simples; MEI e não optante não podem (E0710–E0713).
  if (e.opcaoSimples === '3') return el('totTrib', [el('pTotTribSN', e.aliquotaAproximadaSimples ?? '0')])
  return el('totTrib', [el('indTotTrib', '0')])
}

export const montarDps = (d: DadosDps): { id: string; xml: string } => {
  const { emitente } = d
  const id = idDps(emitente, d.serie, d.numero)
  const meEpp = emitente.opcaoSimples === '3'
  const descricao = d.descricao.trim().slice(0, 1000)
  const corpo = [
    el('tpAmb', d.ambiente === 'producao' ? '1' : '2'),
    el('dhEmi', horaBrasilia(d.emitidaEm)),
    el('verAplic', VERSAO_APLICATIVO),
    el('serie', d.serie.padStart(5, '0')),
    el('nDPS', String(d.numero)),
    el('dCompet', d.competencia),
    el('tpEmit', '1'),
    // A produção restrita já roda o leiaute da NT 009, que exige finNFSe aqui.
    d.ambiente === 'testes' ? el('finNFSe', '0') : '',
    el('cLocEmi', emitente.municipio),
    el('prest', [
      el('CNPJ', digitos(emitente.cnpj)),
      opc('IM', emitente.inscricaoMunicipal),
      el('regTrib', [
        el('opSimpNac', emitente.opcaoSimples),
        meEpp ? el('regApTribSN', emitente.apuracaoSimples ?? '1') : '',
        el('regEspTrib', '0'),
      ]),
    ]),
    d.tomador ? tomadorXml(d.tomador) : '',
    // Produção restrita (esquemas de 24/11/2026): indDest saiu do grupo IBSCBS e virou obrigatório aqui.
    // 0 = o destinatário é o próprio tomador.
    d.ambiente === 'testes' ? el('indDest', '0') : '',
    el('serv', [
      el('locPrest', [el('cLocPrestacao', d.municipioPrestacao ?? emitente.municipio)]),
      // Produção (1.01) tem cNBS depois da descrição; a produção restrita (NT 009) passou para antes.
      el(
        'cServ',
        d.ambiente === 'producao'
          ? [el('cTribNac', d.codigoServico), el('xDescServ', descricao), opc('cNBS', d.codigoNbs)]
          : [el('cTribNac', d.codigoServico), opc('cNBS', d.codigoNbs), el('xDescServ', descricao)],
      ),
    ]),
    el('valores', [
      el('vServPrest', [el('vServ', centavosParaDecimal(d.valorCentavos))]),
      el('trib', [el('tribMun', [el('tribISSQN', '1'), el('tpRetISSQN', '1')]), totalTributosXml(emitente)]),
    ]),
  ].join('')
  return {
    id,
    xml: `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NFSE_NS}" versao="${VERSAO_LEIAUTE}"><infDPS Id="${id}">${corpo}</infDPS></DPS>`,
  }
}

export interface DadosCancelamento {
  ambiente: Ambiente
  emitente: Emitente
  chave: string
  em: Date
  /** 1 = erro na emissão, 2 = serviço não prestado, 9 = outros. */
  codigoMotivo: '1' | '2' | '9'
  /** 15 a 255 caracteres. */
  motivo: string
}

const EVENTO_CANCELAMENTO = '101101'

export const montarCancelamento = (d: DadosCancelamento): string => {
  const id = `PRE${d.chave}${EVENTO_CANCELAMENTO}`
  const corpo = [
    el('tpAmb', d.ambiente === 'producao' ? '1' : '2'),
    el('verAplic', VERSAO_APLICATIVO),
    el('dhEvento', horaBrasilia(d.em)),
    el('CNPJAutor', digitos(d.emitente.cnpj)),
    el('chNFSe', d.chave),
    el(`e${EVENTO_CANCELAMENTO}`, [
      el('xDesc', 'Cancelamento de NFS-e'),
      el('cMotivo', d.codigoMotivo),
      el('xMotivo', d.motivo.trim().padEnd(15, '.').slice(0, 255)),
    ]),
  ].join('')
  return `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NFSE_NS}" versao="${VERSAO_LEIAUTE}"><infPedReg Id="${id}">${corpo}</infPedReg></pedRegEvento>`
}

/** Primeiro `<tag>valor</tag>` do XML. */
export const valorXml = (xml: string, tag: string): string | undefined => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]
