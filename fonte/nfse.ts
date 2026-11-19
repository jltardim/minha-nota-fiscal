// Minha Nota Fiscal: emite NFS-e no Sistema Nacional direto pela API oficial, com o certificado A1 da empresa.
// Uso: node ferramentas/nfse.mjs <comando> [opções]. Rode `node ferramentas/nfse.mjs ajuda` para a lista.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { assinarXml } from './assinatura'
import { abrirPfx, carregarCertificado, ErroCertificado, guardarSenha, nomeDoCofre, pastaSincronizada, pedirSenhaNaTela, type Certificado } from './certificado'
import { publicLookupUrl, renderDanfse } from './danfse'
import { dataBrasilia, digitos, montarCancelamento, montarDps, servidores, valorXml, type Ambiente, type Emitente, type Tomador } from './dps'
import { chamar, errosDoGoverno, type ErroGoverno, type Resposta } from './governo'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARQ_EMPRESA = join(RAIZ, 'empresa.json')
const PASTA_NOTAS = join(RAIZ, 'notas')
const ARQ_NUMERACAO = join(PASTA_NOTAS, '.numeracao.json')
const TABELAS = join(RAIZ, 'ferramentas', 'tabelas')
const ESQUEMAS = join(RAIZ, 'ferramentas', 'esquemas')

// ---------- utilidades ----------

const sair: (msg: string, codigo?: number) => never = (msg, codigo = 1) => {
  console.error(msg)
  process.exit(codigo)
}

const lerJson = <T>(arq: string): T => JSON.parse(readFileSync(arq, 'utf8')) as T
const gravarJson = (arq: string, dados: unknown): void => {
  mkdirSync(dirname(arq), { recursive: true })
  writeFileSync(arq, `${JSON.stringify(dados, null, 2)}\n`)
}

const semAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const reais = (centavos: number): string => `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dataBr = (iso: string): string => iso.slice(0, 10).split('-').reverse().join('/')

const formatarDoc = (doc: string): string =>
  doc.length === 14 ? doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')

const cnpjValido = (cnpj: string): boolean => {
  const d = digitos(cnpj)
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const soma = [...base].reduce((s, c, i) => s + Number(c) * (pesos[i] ?? 0), 0)
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13])
}

const cpfValido = (cpf: string): boolean => {
  const d = digitos(cpf)
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false
  const dv = (n: number) => {
    const soma = [...d.slice(0, n)].reduce((s, c, i) => s + Number(c) * (n + 1 - i), 0)
    const r = (soma * 10) % 11
    return r === 10 ? 0 : r
  }
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10])
}

const argumentos = process.argv.slice(2)
const comando = argumentos[0] ?? 'ajuda'
const posicionais = argumentos.slice(1).filter((a) => !a.startsWith('--'))
const opcao = (nome: string): string | undefined => {
  const i = argumentos.indexOf(`--${nome}`)
  return i >= 0 ? argumentos[i + 1] : undefined
}
const temFlag = (nome: string): boolean => argumentos.includes(`--${nome}`)

// ---------- tabelas oficiais (Anexos A e B) ----------

type Municipio = { codigo: string; nome: string; uf: string }
type Servico = { codigo: string; descricao: string }
let cacheMun: Municipio[] | undefined
const municipios = (): Municipio[] => (cacheMun ??= lerJson<Municipio[]>(join(TABELAS, 'municipios.json')))
const municipio = (codigo: string): Municipio | undefined => municipios().find((m) => m.codigo === codigo)
const nomeMunicipio = (codigo: string): string => {
  const m = municipio(codigo)
  return m ? `${m.nome}/${m.uf}` : `município ${codigo} (não encontrado na tabela oficial)`
}
const servicos = (): Servico[] => lerJson<Servico[]>(join(TABELAS, 'servicos.json'))
const nbsLista = (): Servico[] => lerJson<Servico[]>(join(TABELAS, 'nbs.json'))

// ---------- empresa (cadastro único) ----------

interface ServicoCadastrado {
  /** Nome curto que a pessoa usa no dia a dia, ex.: "consultoria". */
  apelido: string
  codigo: string
  nbs?: string
  descricaoPadrao?: string
}

interface Empresa {
  ambiente: Ambiente
  cnpj: string
  razaoSocial: string
  municipio: string
  inscricaoMunicipal?: string
  opcaoSimples: '1' | '2' | '3'
  apuracaoSimples?: '1' | '2' | '3'
  aliquotaAproximadaSimples?: string
  serie: string
  certificado: string
  servicos: ServicoCadastrado[]
}

const REGIMES: Record<string, string> = { '1': 'Fora do Simples Nacional', '2': 'MEI', '3': 'Simples Nacional (ME/EPP)' }

const carregarEmpresa = (): Empresa => {
  if (!existsSync(ARQ_EMPRESA)) sair('Ainda não existe o empresa.json. Faça a configuração primeiro (veja empresa.exemplo.json).')
  return lerJson<Empresa>(ARQ_EMPRESA)
}

const problemasDaEmpresa = (e: Empresa): string[] => {
  const p: string[] = []
  if (e.ambiente !== 'testes' && e.ambiente !== 'producao') p.push('ambiente precisa ser "testes" ou "producao".')
  if (!cnpjValido(e.cnpj)) p.push('CNPJ inválido.')
  if (!e.razaoSocial?.trim()) p.push('falta a razão social.')
  if (!/^\d{7}$/.test(e.municipio ?? '') || !municipio(e.municipio)) p.push('município precisa ser o código IBGE de 7 dígitos (use o comando cidade).')
  if (!['1', '2', '3'].includes(e.opcaoSimples)) p.push('opcaoSimples precisa ser 1 (fora do Simples), 2 (MEI) ou 3 (ME/EPP).')
  if (e.opcaoSimples === '1') p.push('empresa fora do Simples: desde 03/08/2026 a nota exige IBS/CBS, que esta versão ainda não preenche.')
  if (e.opcaoSimples === '3') {
    if (!['1', '2', '3'].includes(e.apuracaoSimples ?? '')) p.push('ME/EPP precisa de apuracaoSimples (quase sempre "1"; confirme com o contador).')
    if (!/^\d{1,2}\.\d{2}$/.test(e.aliquotaAproximadaSimples ?? '')) p.push('ME/EPP precisa de aliquotaAproximadaSimples com ponto e 2 casas, ex.: "6.00" (peça ao contador).')
  }
  if (e.opcaoSimples === '2' && e.apuracaoSimples) p.push('MEI não informa apuracaoSimples: apague esse campo.')
  if (!/^\d{1,5}$/.test(e.serie ?? '') || Number(e.serie) < 1 || Number(e.serie) > 49999) p.push('serie precisa ser de 1 a 49999 (padrão: "1").')
  if (!e.certificado) p.push('falta o caminho do certificado.')
  if (!e.servicos?.length) p.push('cadastre pelo menos um serviço (use o comando servico para achar o código).')
  for (const s of e.servicos ?? []) {
    if (!/^\d{6}$/.test(s.codigo) || !servicos().some((x) => x.codigo === s.codigo)) p.push(`serviço "${s.apelido}": código ${s.codigo} não existe na lista nacional.`)
    if (s.nbs && (!/^\d{9}$/.test(s.nbs) || !nbsLista().some((x) => x.codigo === s.nbs))) p.push(`serviço "${s.apelido}": NBS ${s.nbs} não existe na tabela.`)
  }
  return p
}

const emitenteDe = (e: Empresa): Emitente => ({
  cnpj: e.cnpj,
  municipio: e.municipio,
  inscricaoMunicipal: e.inscricaoMunicipal || undefined,
  opcaoSimples: e.opcaoSimples,
  apuracaoSimples: e.opcaoSimples === '3' ? e.apuracaoSimples : undefined,
  aliquotaAproximadaSimples: e.opcaoSimples === '3' ? e.aliquotaAproximadaSimples : undefined,
})

const caminhoCertificado = (e: Empresa): string => (isAbsolute(e.certificado) ? e.certificado : join(RAIZ, e.certificado))

const abrirCertificadoDaEmpresa = (e: Empresa): Certificado => {
  let cert: Certificado
  try {
    cert = carregarCertificado(caminhoCertificado(e), digitos(e.cnpj))
  } catch (erro) {
    return sair(erro instanceof ErroCertificado ? erro.message : String(erro))
  }
  if (new Date(cert.validoAte) <= new Date()) sair(`O certificado venceu em ${dataBr(cert.validoAte)}. Renove com a certificadora.`)
  if (cert.cnpj && cert.cnpj.slice(0, 8) !== digitos(e.cnpj).slice(0, 8)) sair(`O certificado é do CNPJ ${formatarDoc(cert.cnpj)}, mas a empresa configurada é ${formatarDoc(digitos(e.cnpj))}.`)
  return cert
}

// ---------- notas ----------

type Situacao = 'rascunho' | 'enviando' | 'incerta' | 'emitida' | 'recusada' | 'cancelada'

interface Pedido {
  servico: string
  descricao?: string
  valor: string | number
  competencia?: string
  tomador?: Tomador
  municipioPrestacao?: string
}

interface Estado {
  id: string
  ambiente: Ambiente
  situacao: Situacao
  pedido: Pedido
  numeroDps?: number
  idDps?: string
  chave?: string
  numeroNfse?: string
  erros?: (ErroGoverno & { dica?: string })[]
  alertas?: unknown
  criadaEm: string
  atualizadaEm: string
  emitidaEm?: string
  canceladaEm?: string
}

const pastaNota = (id: string): string => join(PASTA_NOTAS, id)
const arqEstado = (id: string): string => join(pastaNota(id), 'estado.json')
const lerEstado = (id: string): Estado => {
  if (!existsSync(arqEstado(id))) sair(`Não achei a nota "${id}". Veja as notas com: node ferramentas/nfse.mjs listar`)
  return lerJson<Estado>(arqEstado(id))
}
const salvar = (e: Estado, mudancas: Partial<Estado> = {}): Estado => {
  const novo = { ...e, ...mudancas, atualizadaEm: new Date().toISOString() }
  gravarJson(arqEstado(e.id), novo)
  return novo
}

const proximoNumero = (amb: Ambiente): number => {
  const n = existsSync(ARQ_NUMERACAO) ? lerJson<Record<string, number>>(ARQ_NUMERACAO) : {}
  n[amb] = (n[amb] ?? 0) + 1
  gravarJson(ARQ_NUMERACAO, n)
  return n[amb]
}

const centavos = (valor: string | number): number => {
  const texto = typeof valor === 'number' ? String(valor) : valor.replace(/[R$\s]/g, '')
  const normal = texto.includes(',') ? texto.replace(/\./g, '').replace(',', '.') : texto
  const n = Math.round(Number(normal) * 100)
  return Number.isFinite(n) ? n : NaN
}

/** Confere o pedido antes de qualquer coisa ir para o governo. Devolve erros (bloqueiam) e avisos (vão no resumo). */
const conferirPedido = (emp: Empresa, p: Pedido): { erros: string[]; avisos: string[]; servico?: ServicoCadastrado } => {
  const erros: string[] = []
  const avisos: string[] = []
  const servico = emp.servicos.find((s) => s.apelido === p.servico || s.codigo === p.servico)
  if (!servico) erros.push(`serviço "${p.servico}" não está cadastrado no empresa.json.`)
  const v = centavos(p.valor)
  if (!(v > 0)) erros.push('valor inválido.')
  const descricao = (p.descricao ?? servico?.descricaoPadrao ?? '').trim()
  if (!descricao) erros.push('falta a descrição do serviço.')
  if (descricao.length > 1000) erros.push('descrição passa de 1.000 caracteres.')
  const hoje = dataBrasilia(new Date())
  if (p.competencia && !/^\d{4}-\d{2}-\d{2}$/.test(p.competencia)) erros.push('competência precisa ser AAAA-MM-DD.')
  if (p.competencia && p.competencia > hoje) erros.push('a data de competência (dia do serviço) não pode ser no futuro.')
  if (p.tomador) {
    const doc = digitos(p.tomador.documento ?? '')
    if (doc.length === 14 ? !cnpjValido(doc) : !cpfValido(doc)) erros.push('CPF ou CNPJ do cliente inválido (dígito verificador não confere).')
    if (doc === digitos(emp.cnpj)) erros.push('o cliente não pode ser a própria empresa.')
    if (!p.tomador.nome?.trim()) erros.push('falta o nome do cliente.')
    if (p.tomador.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.tomador.email)) erros.push('e-mail do cliente inválido.')
    const end = p.tomador.endereco
    if (end) {
      if (!municipio(end.municipio)) erros.push('município do cliente precisa ser o código IBGE (use o comando cep ou cidade).')
      if (digitos(end.cep ?? '').length !== 8) erros.push('CEP do cliente precisa ter 8 dígitos.')
      if (!end.logradouro?.trim() || !end.numero?.trim() || !end.bairro?.trim()) erros.push('endereço do cliente precisa de logradouro, número e bairro.')
    } else {
      avisos.push('sem endereço do cliente: a nota sai só com nome e documento (é aceito no caso simples).')
    }
  } else {
    avisos.push('nota sem cliente identificado.')
  }
  if (p.municipioPrestacao && p.municipioPrestacao !== emp.municipio) {
    if (!municipio(p.municipioPrestacao)) erros.push('município da prestação precisa ser o código IBGE.')
    else avisos.push(`serviço prestado fora da sua cidade (${nomeMunicipio(p.municipioPrestacao)}). Para alguns serviços o ISS passa a ser devido lá. Confirme com o contador antes de aprovar.`)
  }
  return { erros, avisos, servico }
}

const dadosDaNota = (emp: Empresa, est: Estado, numero: number, emitidaEm: Date) => {
  const p = est.pedido
  const s = emp.servicos.find((x) => x.apelido === p.servico || x.codigo === p.servico) as ServicoCadastrado
  return montarDps({
    ambiente: est.ambiente,
    emitente: emitenteDe(emp),
    serie: emp.serie,
    numero,
    emitidaEm,
    competencia: p.competencia ?? dataBrasilia(emitidaEm),
    tomador: p.tomador,
    municipioPrestacao: p.municipioPrestacao,
    codigoServico: s.codigo,
    codigoNbs: s.nbs,
    descricao: (p.descricao ?? s.descricaoPadrao ?? '').trim(),
    valorCentavos: centavos(p.valor),
  })
}

const validarXsd = (xml: string, amb: Ambiente, esquema: string, arq: string): string | undefined => {
  writeFileSync(arq, xml)
  try {
    execFileSync('xmllint', ['--noout', '--schema', join(ESQUEMAS, amb, esquema), arq], { stdio: 'pipe' })
    return undefined
  } catch (erro) {
    const saida = String((erro as { stderr?: Buffer }).stderr ?? (erro as Error).message)
    if ((erro as { code?: string }).code === 'ENOENT' || /ENOENT/.test(saida)) return undefined // sem xmllint (ex.: Windows): o governo valida de qualquer jeito
    return saida.split('\n').filter((l) => l && !l.endsWith('fails to validate')).slice(0, 5).join('\n')
  }
}

const resumo = (emp: Empresa, est: Estado, avisos: string[]): string => {
  const p = est.pedido
  const s = emp.servicos.find((x) => x.apelido === p.servico || x.codigo === p.servico)
  const lista = servicos().find((x) => x.codigo === s?.codigo)
  const t = p.tomador
  const end = t?.endereco
  const linhas: (string | null)[] = [
    `PRÉVIA DA NOTA "${est.id}"`,
    est.ambiente === 'testes' ? 'Ambiente: TESTES (produção restrita do governo, sem valor fiscal)' : 'Ambiente: PRODUÇÃO (nota fiscal de verdade)',
    '',
    `Prestador:   ${emp.razaoSocial} · CNPJ ${formatarDoc(digitos(emp.cnpj))} · ${nomeMunicipio(emp.municipio)}`,
    `Regime:      ${REGIMES[emp.opcaoSimples]}${emp.opcaoSimples === '3' ? ` · alíquota aproximada ${emp.aliquotaAproximadaSimples?.replace('.', ',')}%` : ''}`,
    t ? `Cliente:     ${t.nome} · ${digitos(t.documento).length === 14 ? 'CNPJ' : 'CPF'} ${formatarDoc(digitos(t.documento))}${t.email ? ` · ${t.email}` : ''}` : 'Cliente:     não identificado',
    end ? `Endereço:    ${end.logradouro}, ${end.numero}${end.complemento ? ` ${end.complemento}` : ''} · ${end.bairro} · ${nomeMunicipio(end.municipio)} · CEP ${digitos(end.cep)}` : null,
    `Serviço:     ${s?.codigo.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3')} ${lista?.descricao ?? ''}${s?.nbs ? ` · NBS ${s.nbs}` : ''}`,
    `Descrição:   ${(p.descricao ?? s?.descricaoPadrao ?? '').trim()}`,
    `Prestado em: ${nomeMunicipio(p.municipioPrestacao ?? emp.municipio)}`,
    `Valor:       ${reais(centavos(p.valor))}`,
    `Competência: ${dataBr(p.competencia ?? dataBrasilia(new Date()))}`,
    'ISS:         não retido (o prestador recolhe)',
    ...(avisos.length ? ['', 'Avisos:', ...avisos.map((a) => `  - ${a}`)] : []),
  ]
  return linhas.filter((l) => l !== null).join('\n')
}

// Dicas em português simples para as recusas mais comuns (Anexo I do Sistema Nacional NFS-e).
const DICAS: Record<string, string> = {
  E0004: 'Identificador da DPS montado errado. Avise quem mantém a ferramenta.',
  E0006: 'Ambiente trocado: a nota de testes foi para produção ou o contrário.',
  E0008: 'O relógio do computador está adiantado. Acerte a hora e tente de novo.',
  E0014: 'Esse número de DPS já foi usado. A ferramenta tenta o próximo sozinha.',
  E0015: 'A data de competência é depois da emissão. Use o dia em que o serviço foi prestado.',
  E0037: 'Sua cidade não tem convênio com o Sistema Nacional. Emita pelo sistema da prefeitura.',
  E0038: 'O convênio da sua cidade não está ativo neste ambiente.',
  E0039: 'Sua cidade não aceita o Emissor Nacional para este caso. Fale com o contador ou a prefeitura.',
  E0041: 'O município do MEI precisa ser o do endereço do CNPJ.',
  E0084: 'O município do emitente precisa ser o do endereço do CNPJ.',
  E0116: 'A prefeitura exige a inscrição municipal. Preencha inscricaoMunicipal no empresa.json.',
  E0119: 'Inscrição municipal não autorizada. Confira o número com a prefeitura.',
  E0120: 'A prefeitura não tem inscrição municipal cadastrada no sistema nacional. Deixe inscricaoMunicipal vazio.',
  E0160: 'O regime informado (MEI, ME/EPP) não bate com o cadastro do Simples. Confira o opcaoSimples.',
  E0162: 'MEI não informa apuracaoSimples. Apague esse campo.',
  E0166: 'ME/EPP precisa de apuracaoSimples (normalmente "1").',
  E0188: 'CNPJ do cliente inválido.',
  E0190: 'CNPJ do cliente não existe na Receita.',
  E0202: 'O cliente não pode ser a própria empresa.',
  E0206: 'CPF do cliente inválido.',
  E0207: 'CPF do cliente não existe na Receita.',
  E0238: 'Município do cliente inexistente.',
  E0240: 'O CEP do cliente não é da cidade informada. Use o comando cep para pegar a cidade certa.',
  E0310: 'Código de serviço inexistente.',
  E0312: 'Sua cidade não aceita esse código de serviço. Confira o código com o contador.',
  E0316: 'Código NBS inexistente.',
  E0539: 'O código de serviço não é tributável assim na sua cidade. Provavelmente o código está errado.',
  E0540: 'O código de serviço não é tributável assim na sua cidade. Provavelmente o código está errado.',
  E0625: 'ME/EPP sem retenção não informa alíquota.',
  E0710: 'MEI não informa a alíquota aproximada do Simples.',
  E0712: 'ME/EPP precisa da alíquota aproximada do Simples (aliquotaAproximadaSimples).',
  E0714: 'Assinatura ausente. Confira o certificado.',
  E0717: 'Assinatura inválida. Não edite o XML depois de assinado.',
  E0718: 'A nota foi assinada com o certificado de outro CNPJ.',
  E1228: 'XML com prefixo de namespace. Avise quem mantém a ferramenta.',
  E1235: 'XML fora do modelo oficial. Avise quem mantém a ferramenta.',
}
const comDica = (erros: ErroGoverno[]) => erros.map((e) => ({ ...e, ...(DICAS[e.codigo] ? { dica: DICAS[e.codigo] } : {}) }))
const mostrarErros = (erros: (ErroGoverno & { dica?: string })[]): string =>
  erros.map((e) => `  - ${e.codigo}: ${e.mensagem}${e.complemento ? ` (${e.complemento})` : ''}${e.dica ? `\n    O que fazer: ${e.dica}` : ''}`).join('\n')

const gerarPdf = async (est: Estado): Promise<string | undefined> => {
  const arqXml = join(pastaNota(est.id), 'nfse.xml')
  if (!existsSync(arqXml)) return undefined
  const pdf = await renderDanfse(readFileSync(arqXml, 'utf8'), { isCanceled: est.situacao === 'cancelada' })
  const arq = join(pastaNota(est.id), 'nota.pdf')
  writeFileSync(arq, pdf)
  return arq
}

const marcarEmitida = async (est: Estado, chave: string, nfseXml: string | undefined, extra: Partial<Estado> = {}): Promise<Estado> => {
  if (nfseXml) writeFileSync(join(pastaNota(est.id), 'nfse.xml'), nfseXml)
  const novo = salvar(est, {
    situacao: 'emitida',
    chave,
    numeroNfse: nfseXml ? valorXml(nfseXml, 'nNFSe') : undefined,
    emitidaEm: (nfseXml && valorXml(nfseXml, 'dhProc')) || new Date().toISOString(),
    erros: undefined,
    ...extra,
  })
  await gerarPdf(novo)
  return novo
}

const mostrarEmitida = (est: Estado): void => {
  console.log(`NOTA EMITIDA${est.ambiente === 'testes' ? ' (AMBIENTE DE TESTES, sem valor fiscal)' : ''}`)
  console.log(`  Número da NFS-e: ${est.numeroNfse ?? '(veja no XML)'}`)
  console.log(`  Chave de acesso: ${est.chave}`)
  console.log(`  PDF:  ${join('notas', est.id, 'nota.pdf')}`)
  console.log(`  XML:  ${join('notas', est.id, 'nfse.xml')}`)
  if (est.ambiente === 'producao') console.log(`  Consulta pública: ${publicLookupUrl(est.chave ?? '')}`)
}

/** Procura no governo a NFS-e já gerada para o idDps desta nota (resposta perdida ou número usado em outro lugar). */
const buscarEmitida = async (cert: Certificado, est: Estado): Promise<{ chave: string; xml?: string } | 'nao-achou' | 'de-outra-nota' | 'sem-resposta'> => {
  const { sefin } = servidores[est.ambiente]
  try {
    const r = await chamar(cert, sefin, 'GET', `/SefinNacional/dps/${est.idDps}`)
    if (r.status === 404) return 'nao-achou'
    const chave = String(r.json.chaveAcesso ?? '')
    if (r.status !== 200 || !chave) return 'sem-resposta'
    const n = await chamar(cert, sefin, 'GET', `/SefinNacional/nfse/${chave}`)
    const xml = n.json.nfseXml as string | undefined
    if (!xml) return { chave }
    const mesmoValor = valorXml(xml, 'vServ') === (centavos(est.pedido.valor) / 100).toFixed(2)
    const doc = digitos(est.pedido.tomador?.documento ?? '')
    // A descrição também precisa bater: duas notas de teste com o mesmo valor e o mesmo cliente não se confundem.
    const servico = carregarEmpresa().servicos.find((s) => s.apelido === est.pedido.servico || s.codigo === est.pedido.servico)
    const descricao = (est.pedido.descricao ?? servico?.descricaoPadrao ?? '').trim().slice(0, 1000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const mesmaDescricao = !descricao || xml.includes(`<xDescServ>${descricao}</xDescServ>`)
    return mesmoValor && mesmaDescricao && (!doc || xml.includes(`>${doc}<`)) ? { chave, xml } : 'de-outra-nota'
  } catch {
    return 'sem-resposta'
  }
}

// ---------- comandos ----------

const AJUDA = `Minha Nota Fiscal: comandos

Cadastro
  cidade <nome> [UF]          acha o código IBGE da cidade
  servico <palavras>          acha o código do serviço (lista nacional) e o NBS
  cnpj <cnpj>                 consulta pública do CNPJ (BrasilAPI): nome, cidade, Simples/MEI
  cep <cep>                   endereço e código IBGE da cidade (ViaCEP)
  certificado [arquivo.pfx]   abre o certificado e mostra titular, CNPJ e validade
  guardar-senha               abre uma janela do sistema para a senha do certificado e guarda no cofre do computador
  verificar                   confere o empresa.json, o certificado e se a cidade está no Sistema Nacional

Notas
  previa <pedido.json> [--id nome]   monta a nota, confere tudo e mostra o resumo (não envia nada)
  emitir <id> --confirmo             envia ao governo (só depois do OK da pessoa no resumo)
  consultar <id>                     pergunta ao governo como a nota está
  pdf <id>                           gera de novo o PDF
  cancelar <id> --motivo "texto" [--codigo 1|2|9] --confirmo
  listar                             mostra as notas
`

const cmdCidade = () => {
  const [nome, uf] = posicionais
  if (!nome) sair('Uso: cidade <nome> [UF]')
  const alvo = semAcento(nome as string)
  const achados = municipios().filter((m) => semAcento(m.nome).includes(alvo) && (!uf || m.uf.toLowerCase() === uf.toLowerCase()))
  if (!achados.length) sair('Nenhuma cidade encontrada.')
  for (const m of achados.slice(0, 15)) console.log(`${m.codigo}  ${m.nome}/${m.uf}`)
}

const cmdServico = () => {
  const termos = posicionais.map(semAcento)
  if (!termos.length) sair('Uso: servico <palavras>')
  const casa = (t: string) => termos.every((x) => semAcento(t).includes(x))
  const s = servicos().filter((x) => casa(x.descricao) || x.codigo.startsWith(termos[0] as string))
  const n = nbsLista().filter((x) => casa(x.descricao))
  console.log('Código de serviço (lista nacional, vai em "codigo"):')
  for (const x of s.slice(0, 15)) console.log(`  ${x.codigo}  ${x.descricao}`)
  if (!s.length) console.log('  nada encontrado')
  console.log('\nNBS (vai em "nbs"):')
  for (const x of n.slice(0, 10)) console.log(`  ${x.codigo}  ${x.descricao}`)
  if (!n.length) console.log('  nada encontrado')
}

const cmdCnpj = async () => {
  const doc = digitos(posicionais[0] ?? '')
  if (!cnpjValido(doc)) sair('CNPJ inválido.')
  const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${doc}`)
  if (!r.ok) sair(`A consulta pública do CNPJ falhou (HTTP ${r.status}). Preencha os dados à mão.`)
  const j = (await r.json()) as Record<string, unknown>
  const cod = String(j.codigo_municipio_ibge ?? '')
  console.log(`Razão social:  ${j.razao_social}`)
  if (j.nome_fantasia) console.log(`Nome fantasia: ${j.nome_fantasia}`)
  console.log(`Situação:      ${j.descricao_situacao_cadastral}`)
  console.log(`Cidade:        ${j.municipio}/${j.uf}${cod ? ` · código IBGE ${cod}` : ''}`)
  console.log(`Endereço:      ${[j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' ')}, ${j.numero}${j.complemento ? ` ${j.complemento}` : ''} · ${j.bairro} · CEP ${j.cep}`)
  console.log(`Simples:       ${j.opcao_pelo_simples ? 'optante' : 'não optante'}${j.opcao_pelo_mei ? ' · MEI' : ''}`)
  console.log(`Atividade:     ${j.cnae_fiscal} ${j.cnae_fiscal_descricao}`)
  console.log('\nAtenção: a BrasilAPI repete dados da Receita e pode estar atrasada. Confirme o regime com o contador.')
}

const cmdCep = async () => {
  const cep = digitos(posicionais[0] ?? '')
  if (cep.length !== 8) sair('CEP precisa ter 8 dígitos.')
  const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`)
  const j = (await r.json()) as Record<string, string>
  if (!r.ok || j.erro) sair('CEP não encontrado.')
  console.log(JSON.stringify({ municipio: j.ibge, cep, logradouro: j.logradouro, bairro: j.bairro, cidade: `${j.localidade}/${j.uf}` }, null, 2))
}

const cmdCertificado = () => {
  const emp = existsSync(ARQ_EMPRESA) ? lerJson<Empresa>(ARQ_EMPRESA) : undefined
  const caminho = posicionais[0] ? resolve(posicionais[0]) : emp ? caminhoCertificado(emp) : sair('Uso: certificado <arquivo.pfx>')
  const nuvem = pastaSincronizada(caminho)
  if (nuvem) console.log(`ATENÇÃO: o certificado está em ${nuvem}. Mova a pasta para fora da nuvem (ex.: ~/minha-nota-fiscal).`)
  const conta = digitos(emp?.cnpj ?? '')
  let cert: Certificado
  try {
    cert = carregarCertificado(caminho, conta)
  } catch (erro) {
    return sair(erro instanceof ErroCertificado ? erro.message : String(erro))
  }
  const vencido = new Date(cert.validoAte) <= new Date()
  console.log(`Titular:   ${cert.titular}`)
  console.log(`CNPJ:      ${cert.cnpj ? formatarDoc(cert.cnpj) : 'não encontrado no certificado'}`)
  console.log(`Válido até ${dataBr(cert.validoAte)}${vencido ? '  (VENCIDO)' : ''}`)
}

const cmdGuardarSenha = () => {
  const emp = existsSync(ARQ_EMPRESA) ? lerJson<Empresa>(ARQ_EMPRESA) : undefined
  if (!emp) sair('Preencha o empresa.json (CNPJ e caminho do certificado) antes de guardar a senha.')
  const caminho = caminhoCertificado(emp as Empresa)
  if (!existsSync(caminho)) sair(`Não achei o certificado em ${caminho}.`)
  const pfx = readFileSync(caminho)
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const senha = pedirSenhaNaTela(tentativa === 1 ? `Digite a senha do certificado digital (A1) da empresa. Ela vai direto para o ${nomeDoCofre()} e não aparece no chat.` : 'Senha incorreta. Tente de novo:')
    if (senha === undefined) sair('Cancelado. Nada foi guardado.')
    try {
      const cert = abrirPfx(pfx, senha as string)
      guardarSenha(digitos((emp as Empresa).cnpj), senha as string)
      console.log(`Senha guardada no ${nomeDoCofre()}. Certificado de ${cert.titular}, válido até ${dataBr(cert.validoAte)}.`)
      return
    } catch (erro) {
      if (!(erro instanceof ErroCertificado) || !/incorreta/.test(erro.message)) sair(erro instanceof Error ? erro.message : String(erro))
    }
  }
  sair('Três tentativas sem acertar a senha. Nada foi guardado.')
}

const cmdVerificar = async () => {
  const emp = carregarEmpresa()
  const problemas = problemasDaEmpresa(emp)
  console.log(`Empresa:   ${emp.razaoSocial} · CNPJ ${formatarDoc(digitos(emp.cnpj))}`)
  console.log(`Cidade:    ${nomeMunicipio(emp.municipio)} · Regime: ${REGIMES[emp.opcaoSimples] ?? '?'}`)
  console.log(`Ambiente:  ${emp.ambiente === 'producao' ? 'PRODUÇÃO (notas de verdade)' : 'TESTES (sem valor fiscal)'}`)
  if (problemas.length) sair(`\nAcerte no empresa.json:\n${problemas.map((p) => `  - ${p}`).join('\n')}`)
  const nuvem = pastaSincronizada(caminhoCertificado(emp))
  if (nuvem) console.log(`ATENÇÃO: o certificado está em ${nuvem}. Mova a pasta para fora da nuvem.`)
  const cert = abrirCertificadoDaEmpresa(emp)
  console.log(`Certificado: ${cert.titular}, válido até ${dataBr(cert.validoAte)}`)
  const dias = Math.floor((new Date(cert.validoAte).getTime() - Date.now()) / 86_400_000)
  if (dias < 30) console.log(`  Atenção: o certificado vence em ${dias} dias.`)
  // --ambiente producao|testes só muda a consulta (leitura); a emissão sempre segue o empresa.json.
  const ambConsulta = (opcao('ambiente') as Ambiente | undefined) ?? emp.ambiente
  const cidadeConsulta = opcao('cidade') ?? emp.municipio
  const { adn } = servidores[ambConsulta]
  try {
    const r = await chamar(cert, adn, 'GET', `/parametrizacao/${cidadeConsulta}/convenio`)
    if (r.status === 200) {
      console.log(`Convênio de ${nomeMunicipio(cidadeConsulta)} no Sistema Nacional (${ambConsulta}): encontrado`)
      console.log(JSON.stringify(r.json, null, 2))
      const conv = (r.json.parametrosConvenio ?? {}) as Record<string, unknown>
      if (conv.aderenteEmissorNacional === 0 && emp.opcaoSimples === '1') {
        // Regra E0039 do Anexo I: empresa fora do Simples não emite pelo nacional em cidade não aderente.
        sair(
          `\nBLOQUEIO: ${nomeMunicipio(cidadeConsulta)} não aceita notas pelo Emissor Nacional (aderenteEmissorNacional = 0).\n` +
            'Empresa fora do Simples precisa emitir pelo sistema de NFS-e da prefeitura (o governo recusa com o erro E0039).',
          2,
        )
      }
      if (conv.aderenteEmissorNacional === 0 && emp.opcaoSimples === '3') {
        // Visto na prática (novembro de 2026): o ambiente de testes recusou com E0039, mas a produção
        // emitiu pelo portal. Desde a Resolução CGSN 189/2026 a ME/EPP do Simples emite pelo nacional mesmo assim.
        console.log(
          `\nATENÇÃO: ${nomeMunicipio(cidadeConsulta)} está marcada como não aderente ao Emissor Nacional.\n` +
            '  - Produção: a ME/EPP do Simples emite pelo nacional mesmo assim (Resolução CGSN 189/2026).\n' +
            '  - Ambiente de testes: pode recusar com o erro E0039. Nesse caso o teste não prova nada; combine com a pessoa\n' +
            '    uma nota real de valor baixo, para ela mesma, cancelada logo depois.',
        )
      }
      if (conv.aderenteEmissorNacional === 1) console.log('\nOK: a cidade aceita notas pelo Emissor Nacional.')
    } else if (r.status === 403) {
      sair('O governo recusou o certificado (HTTP 403). Ele precisa ser um e-CNPJ ICP-Brasil válido do prestador.')
    } else {
      console.log(`Convênio da cidade: o governo respondeu HTTP ${r.status}.`)
      console.log(JSON.stringify(r.json).slice(0, 600))
      if (ambConsulta === 'testes') console.log('O ambiente de testes não tem todas as cidades. Se a sua não estiver, o teste não vai passar, mas a produção pode funcionar.')
      else console.log('Sua cidade pode não emitir pelo Sistema Nacional. Confirme com a prefeitura ou o contador.')
    }
  } catch (erro) {
    sair(`Não consegui falar com o governo: ${(erro as Error).message}`)
  }
}

const cmdPrevia = () => {
  const emp = carregarEmpresa()
  const problemas = problemasDaEmpresa(emp)
  if (problemas.length) sair(`Acerte o empresa.json antes:\n${problemas.map((p) => `  - ${p}`).join('\n')}`)
  const arq = posicionais[0] ?? sair('Uso: previa <pedido.json> [--id nome]')
  const pedido = lerJson<Pedido>(resolve(arq as string))
  const { erros, avisos } = conferirPedido(emp, pedido)
  if (erros.length) sair(`O pedido tem problemas:\n${erros.map((e) => `  - ${e}`).join('\n')}`)
  const base = opcao('id') ?? `${dataBrasilia(new Date())}-${semAcento(pedido.tomador?.nome ?? 'sem-cliente').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`
  let id = base
  // Rascunho ou nota recusada podem ser refeitos com o mesmo nome (a recusada reaproveita o número da DPS).
  const refazivel = (x: string) => !existsSync(arqEstado(x)) || ['rascunho', 'recusada'].includes(lerEstado(x).situacao)
  for (let i = 2; !refazivel(id); i++) id = `${base}-${i}`
  const agora = new Date().toISOString()
  const anterior = existsSync(arqEstado(id)) ? lerEstado(id) : undefined
  const est: Estado = {
    id,
    ambiente: emp.ambiente,
    situacao: 'rascunho',
    pedido,
    ...(anterior?.situacao === 'recusada' && anterior.ambiente === emp.ambiente ? { numeroDps: anterior.numeroDps } : {}),
    criadaEm: anterior?.criadaEm ?? agora,
    atualizadaEm: agora,
  }
  mkdirSync(pastaNota(id), { recursive: true })
  gravarJson(arqEstado(id), est)
  // Confere contra o modelo oficial com um número provisório (o definitivo só sai na emissão).
  const { xml } = dadosDaNota(emp, est, 1, new Date())
  const falha = validarXsd(xml, emp.ambiente === 'producao' ? 'producao' : 'testes', 'DPS_v1.01.xsd', join(pastaNota(id), 'previa-dps.xml'))
  if (falha) sair(`A nota não passou no modelo oficial (XSD):\n${falha}`)
  const texto = resumo(emp, est, avisos)
  writeFileSync(join(pastaNota(id), 'resumo.txt'), `${texto}\n`)
  console.log(texto)
  console.log(`\nNada foi enviado. Para emitir, depois do OK: node ferramentas/nfse.mjs emitir ${id} --confirmo`)
}

const cmdEmitir = async () => {
  const id = posicionais[0] ?? sair('Uso: emitir <id> --confirmo')
  if (!temFlag('confirmo')) sair('Falta --confirmo. Mostre o resumo (comando previa) e só emita depois do OK da pessoa.')
  const emp = carregarEmpresa()
  let est = lerEstado(id as string)
  if (est.ambiente !== emp.ambiente) sair(`Esta prévia foi feita no ambiente "${est.ambiente}", mas a empresa agora está em "${emp.ambiente}". Refaça a prévia.`)
  if (est.situacao === 'emitida' || est.situacao === 'cancelada') return mostrarEmitida(est)
  const problemas = problemasDaEmpresa(emp)
  if (problemas.length) sair(`Acerte o empresa.json antes:\n${problemas.map((p) => `  - ${p}`).join('\n')}`)
  const conferencia = conferirPedido(emp, est.pedido)
  if (conferencia.erros.length) sair(`O pedido tem problemas:\n${conferencia.erros.map((e) => `  - ${e}`).join('\n')}`)
  const cert = abrirCertificadoDaEmpresa(emp)
  const { sefin } = servidores[est.ambiente]

  if (est.situacao === 'enviando' || est.situacao === 'incerta') {
    // Já houve um envio sem resposta: antes de mandar de novo, pergunta ao governo se a nota saiu.
    const achou = await buscarEmitida(cert, est)
    if (achou === 'sem-resposta') sair('O governo ainda não respondeu sobre o envio anterior. Tente de novo em alguns minutos (não emita pelo portal enquanto isso).')
    if (typeof achou === 'object') return mostrarEmitida(await marcarEmitida(est, achou.chave, achou.xml))
  }

  for (let colisoes = 0; colisoes <= 5; colisoes++) {
    const numero = est.numeroDps ?? proximoNumero(est.ambiente)
    const { id: idDps, xml } = dadosDaNota(emp, est, numero, new Date(Date.now() - 60_000))
    const assinado = assinarXml(xml, cert.chavePem, cert.certB64)
    const falha = validarXsd(assinado, est.ambiente, 'DPS_v1.01.xsd', join(pastaNota(est.id), 'dps-assinada.xml'))
    if (falha) sair(`A nota não passou no modelo oficial (XSD), nada foi enviado:\n${falha}`)
    est = salvar(est, { situacao: 'enviando', numeroDps: numero, idDps })
    let r: Resposta
    try {
      r = await chamar(cert, sefin, 'POST', '/SefinNacional/nfse', { dpsXmlGZipB64: gzipSync(assinado).toString('base64') })
    } catch (erro) {
      salvar(est, { situacao: 'incerta' })
      sair(`O governo não respondeu (${(erro as Error).message}). Rode o mesmo comando daqui a pouco: antes de reenviar, ele confere se a nota saiu.`)
    }
    const { nfseXml, ...semXml } = r.json
    gravarJson(join(pastaNota(est.id), 'resposta.json'), { status: r.status, ...semXml })
    if (r.status >= 500) {
      salvar(est, { situacao: 'incerta' })
      sair(`O governo respondeu com erro interno (HTTP ${r.status}). Rode o mesmo comando daqui a pouco.`)
    }
    const chave = String(r.json.chaveAcesso ?? '')
    if (r.status < 300 && chave) return mostrarEmitida(await marcarEmitida(est, chave, nfseXml as string | undefined, { alertas: r.json.alertas }))
    const erros = comDica(errosDoGoverno(r))
    if (!erros.some((e) => e.codigo === 'E0014')) {
      salvar(est, { situacao: 'recusada', erros })
      sair(`O governo recusou a nota (nada foi emitido):\n${mostrarErros(erros)}`)
    }
    // Número já usado: ou é esta nota (resposta perdida) ou outra emitida fora daqui. Confere e passa para o próximo.
    const achou = await buscarEmitida(cert, est)
    if (typeof achou === 'object') return mostrarEmitida(await marcarEmitida(est, achou.chave, achou.xml))
    if (achou === 'sem-resposta') sair('Número de DPS já usado e o governo não respondeu à consulta. Tente de novo em alguns minutos.')
    est = salvar(est, { numeroDps: undefined })
  }
  salvar(est, { situacao: 'recusada' })
  sair('Vários números de DPS seguidos já estavam usados. Confira a numeração em notas/.numeracao.json.')
}

const cmdConsultar = async () => {
  const est = lerEstado(posicionais[0] ?? sair('Uso: consultar <id>'))
  const emp = carregarEmpresa()
  console.log(`Situação aqui: ${est.situacao}${est.idDps ? ` · DPS ${est.idDps}` : ''}`)
  if (!est.idDps) return
  const cert = abrirCertificadoDaEmpresa(emp)
  const achou = await buscarEmitida(cert, est)
  if (typeof achou === 'object') {
    console.log(`No governo: emitida, chave ${achou.chave}`)
    if (est.situacao !== 'emitida' && est.situacao !== 'cancelada') mostrarEmitida(await marcarEmitida(est, achou.chave, achou.xml))
  } else console.log(`No governo: ${achou === 'nao-achou' ? 'não existe nota para esta DPS' : achou === 'de-outra-nota' ? 'o número foi usado por outra nota' : 'sem resposta agora'}`)
}

const cmdPdf = async () => {
  const est = lerEstado(posicionais[0] ?? sair('Uso: pdf <id>'))
  const arq = await gerarPdf(est)
  if (!arq) sair('Esta nota ainda não tem o XML autorizado.')
  console.log(`PDF: ${join('notas', est.id, 'nota.pdf')}`)
}

const cmdCancelar = async () => {
  const est = lerEstado(posicionais[0] ?? sair('Uso: cancelar <id> --motivo "texto" --confirmo'))
  if (!temFlag('confirmo')) sair('Falta --confirmo. Cancelar é definitivo: confirme com a pessoa antes.')
  if (est.situacao === 'cancelada') return console.log('A nota já está cancelada.')
  if (est.situacao !== 'emitida' || !est.chave) sair(`A nota está "${est.situacao}", não emitida.`)
  const motivo = opcao('motivo') ?? sair('Falta --motivo "texto" (15 a 255 caracteres).')
  const codigo = (opcao('codigo') ?? '2') as '1' | '2' | '9'
  if (!['1', '2', '9'].includes(codigo)) sair('--codigo precisa ser 1 (erro na emissão), 2 (serviço não prestado) ou 9 (outros).')
  const emp = carregarEmpresa()
  const cert = abrirCertificadoDaEmpresa(emp)
  const xml = montarCancelamento({ ambiente: est.ambiente, emitente: emitenteDe(emp), chave: est.chave as string, em: new Date(Date.now() - 60_000), codigoMotivo: codigo, motivo: motivo as string })
  const assinado = assinarXml(xml, cert.chavePem, cert.certB64)
  const r = await chamar(cert, servidores[est.ambiente].sefin, 'POST', `/SefinNacional/nfse/${est.chave}/eventos`, {
    pedidoRegistroEventoXmlGZipB64: gzipSync(assinado).toString('base64'),
  })
  gravarJson(join(pastaNota(est.id), 'resposta-cancelamento.json'), { status: r.status, ...r.json })
  if (r.status < 300) {
    const novo = salvar(est, { situacao: 'cancelada', canceladaEm: new Date().toISOString() })
    await gerarPdf(novo)
    return console.log('Nota cancelada. O PDF foi refeito com a marca de cancelada.')
  }
  const erros = comDica(errosDoGoverno(r))
  sair(`O governo recusou o cancelamento:\n${mostrarErros(erros)}\nSe passou do prazo da prefeitura, o caminho é pedir análise fiscal no portal.`)
}

const cmdListar = () => {
  if (!existsSync(PASTA_NOTAS)) return console.log('Nenhuma nota ainda.')
  const ids = readdirSync(PASTA_NOTAS).filter((d) => existsSync(arqEstado(d)))
  if (!ids.length) return console.log('Nenhuma nota ainda.')
  for (const id of ids.sort()) {
    const e = lerEstado(id)
    console.log(`${e.situacao.padEnd(9)} ${e.ambiente.padEnd(8)} ${id}  ${reais(centavos(e.pedido.valor))}  ${e.pedido.tomador?.nome ?? ''}${e.numeroNfse ? `  NFS-e ${e.numeroNfse}` : ''}`)
  }
}

const comandos: Record<string, () => unknown> = {
  ajuda: () => console.log(AJUDA),
  cidade: cmdCidade,
  servico: cmdServico,
  cnpj: cmdCnpj,
  cep: cmdCep,
  certificado: cmdCertificado,
  'guardar-senha': cmdGuardarSenha,
  verificar: cmdVerificar,
  previa: cmdPrevia,
  emitir: cmdEmitir,
  consultar: cmdConsultar,
  pdf: cmdPdf,
  cancelar: cmdCancelar,
  listar: cmdListar,
}

const rodar = comandos[comando] ?? (() => sair(`Comando desconhecido: ${comando}\n\n${AJUDA}`))
Promise.resolve(rodar()).catch((erro) => sair(`Erro: ${erro instanceof Error ? erro.message : String(erro)}`))
