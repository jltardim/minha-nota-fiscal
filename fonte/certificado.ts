// Abertura do .pfx adaptada de emissor-nfse-nacional (c) Gabriel Buzzi Venturi, licença MIT.
// https://github.com/gabrielbuzziv/emissor-nfse-nacional
// A senha nunca passa pelo chat nem fica em arquivo: no Mac, vai para o Keychain por uma janela do próprio sistema.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'

export interface Certificado {
  titular: string
  cnpj?: string
  validoAte: string
  chavePem: string
  /** Certificado do cliente seguido da cadeia que veio no .pfx, em PEM. */
  cadeiaPem: string
  /** Certificado do cliente em base64 DER, como vai dentro de <X509Certificate>. */
  certB64: string
}

export class ErroCertificado extends Error {}

const SERVICO_KEYCHAIN = 'minha-nota-fiscal'

let flagLegado: string[] | undefined
/** O OpenSSL 3+ precisa de -legacy para abrir .pfx antigos (RC2/3DES), comuns em A1; o LibreSSL não. */
const flagsPkcs12 = (): string[] => {
  flagLegado ??= /^OpenSSL [3-9]/.test(execFileSync('openssl', ['version']).toString()) ? ['-legacy'] : []
  return flagLegado
}

const lerPfx = (pfx: Buffer, senha: string, args: string[]): string =>
  execFileSync('openssl', ['pkcs12', ...flagsPkcs12(), '-passin', 'env:SENHA_PFX', ...args], {
    input: pfx,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SENHA_PFX: senha },
    stdio: 'pipe',
  }).toString()

const blocosPem = (texto: string, rotulo: string): string[] =>
  texto.match(new RegExp(`-----BEGIN ${rotulo}-----[\\s\\S]+?-----END ${rotulo}-----`, 'g')) ?? []

export const abrirPfx = (pfx: Buffer, senha: string): Certificado => {
  let folha: string, cadeia: string, chave: string
  try {
    folha = lerPfx(pfx, senha, ['-nokeys', '-clcerts'])
    cadeia = lerPfx(pfx, senha, ['-nokeys', '-cacerts'])
    chave = lerPfx(pfx, senha, ['-nocerts', '-nodes'])
  } catch (erro) {
    const detalhe = String((erro as { stderr?: Buffer }).stderr ?? (erro as Error).message)
    if (/mac verify|invalid password|bad decrypt/i.test(detalhe)) throw new ErroCertificado('Senha do certificado incorreta.')
    throw new ErroCertificado('Não consegui abrir o arquivo. Ele precisa ser um certificado A1 (.pfx ou .p12).')
  }
  const [folhaPem] = blocosPem(folha, 'CERTIFICATE')
  const [chavePem] = [...blocosPem(chave, 'PRIVATE KEY'), ...blocosPem(chave, 'RSA PRIVATE KEY')]
  if (!folhaPem || !chavePem) throw new ErroCertificado('O arquivo não tem o certificado e a chave privada juntos.')
  const x509 = new X509Certificate(folhaPem)
  const nome = x509.subject.match(/CN=([^\n]+)/)?.[1] ?? x509.subject
  return {
    titular: nome,
    cnpj: nome.match(/\d{14}/)?.[0],
    validoAte: new Date(x509.validTo).toISOString(),
    chavePem,
    cadeiaPem: [folhaPem, ...blocosPem(cadeia, 'CERTIFICATE')].join('\n'),
    certB64: x509.raw.toString('base64'),
  }
}

const ehMac = process.platform === 'darwin'

/** Senha do Keychain (Mac) ou da variável NFSE_SENHA_CERTIFICADO. */
export const lerSenha = (conta: string): string | undefined => {
  if (process.env.NFSE_SENHA_CERTIFICADO) return process.env.NFSE_SENHA_CERTIFICADO
  if (!ehMac) return undefined
  try {
    return execFileSync('security', ['find-generic-password', '-a', conta, '-s', SERVICO_KEYCHAIN, '-w'], { stdio: 'pipe' }).toString().replace(/\n$/, '')
  } catch {
    return undefined
  }
}

/** Abre uma janela do macOS pedindo a senha (o texto fica oculto). Devolve undefined se a pessoa cancelar. */
export const pedirSenhaNaTela = (titulo: string): string | undefined => {
  if (!ehMac) throw new ErroCertificado('A janela de senha só existe no Mac. Em outro sistema, defina a variável NFSE_SENHA_CERTIFICADO no seu terminal.')
  const script = `display dialog ${JSON.stringify(titulo)} default answer "" with hidden answer with title "Minha Nota Fiscal" buttons {"Cancelar", "Guardar"} default button "Guardar" cancel button "Cancelar"\ntext returned of result`
  try {
    return execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replace(/\n$/, '')
  } catch {
    return undefined
  }
}

/** Grava no Keychain pelo modo interativo do `security`, para a senha não aparecer na lista de processos. */
export const guardarSenha = (conta: string, senha: string): void => {
  const aspas = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  execFileSync('security', ['-i'], { input: `add-generic-password -U -a ${aspas(conta)} -s ${SERVICO_KEYCHAIN} -l ${aspas('Senha do certificado da nota fiscal')} -w ${aspas(senha)}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
}

export const carregarCertificado = (caminho: string, conta: string): Certificado => {
  if (!existsSync(caminho)) throw new ErroCertificado(`Não achei o certificado em ${caminho}.`)
  const senha = lerSenha(conta)
  if (senha === undefined) throw new ErroCertificado('A senha do certificado ainda não foi guardada. Rode: node ferramentas/nfse.mjs guardar-senha')
  return abrirPfx(readFileSync(caminho), senha)
}

/** Pastas que costumam ir para a nuvem: o certificado não deve morar nelas. */
export const pastaSincronizada = (caminho: string): string | undefined => {
  const casa = process.env.HOME ?? ''
  if (/Mobile Documents|CloudStorage|Google Drive|Dropbox|OneDrive|iCloud/i.test(caminho)) return 'uma pasta de nuvem'
  if (ehMac && (caminho.startsWith(`${casa}/Desktop/`) || caminho.startsWith(`${casa}/Documents/`))) {
    try {
      const saida = execFileSync('defaults', ['read', 'com.apple.finder', 'FXICloudDriveDesktop'], { stdio: 'pipe' }).toString().trim()
      if (saida === '1') return 'a Mesa ou os Documentos sincronizados com o iCloud'
    } catch {
      // Sem a chave: a sincronização da Mesa e Documentos não está ligada (ou não dá para saber).
    }
  }
  return undefined
}
