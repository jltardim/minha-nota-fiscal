// Abertura do .pfx: primeiro em JavaScript puro (node-forge, funciona em Mac, Windows e Linux sem instalar nada); se o
// arquivo usar uma cifra que o forge não abre, tenta o OpenSSL, como no emissor-nfse-nacional (c) Gabriel Buzzi
// Venturi, licença MIT. https://github.com/gabrielbuzziv/emissor-nfse-nacional
//
// A senha nunca passa pelo chat nem fica em texto puro em arquivo. Ela vai para o cofre do sistema:
//   - Mac: Keychain (janela do próprio macOS para digitar);
//   - Windows: cofre do usuário via DPAPI (janela de credencial do próprio Windows para digitar);
//   - Linux: chaveiro do sistema (secret-tool), com janela do zenity quando existir.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'

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

const SERVICO = 'minha-nota-fiscal'
const SO = process.platform

// ---------- abrir o .pfx ----------

const montar = (folhaPem: string, chavePem: string, cadeia: string[]): Certificado => {
  const x509 = new X509Certificate(folhaPem)
  const nome = x509.subject.match(/CN=([^\n]+)/)?.[1] ?? x509.subject
  return {
    titular: nome,
    cnpj: nome.match(/\d{14}/)?.[0],
    validoAte: new Date(x509.validTo).toISOString(),
    chavePem,
    cadeiaPem: [folhaPem, ...cadeia].join('\n'),
    certB64: x509.raw.toString('base64'),
  }
}

const abrirComForge = (pfx: Buffer, senha: string): Certificado => {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))), false, senha)
  const sacos = (tipo: string) => p12.getBags({ bagType: tipo })[tipo] ?? []
  const chaves = [...sacos(forge.pki.oids.pkcs8ShroudedKeyBag), ...sacos(forge.pki.oids.keyBag)].filter((s) => s.key)
  const certs = sacos(forge.pki.oids.certBag).filter((s) => s.cert)
  const chave = chaves[0]?.key as forge.pki.rsa.PrivateKey | undefined
  if (!chave || !certs.length) throw new ErroCertificado('O arquivo não tem o certificado e a chave privada juntos.')
  // A folha é o certificado cuja chave pública casa com a chave privada.
  const folha = certs.find((s) => (s.cert?.publicKey as forge.pki.rsa.PublicKey).n.equals(chave.n)) ?? certs[0]
  const resto = certs.filter((s) => s !== folha).map((s) => forge.pki.certificateToPem(s.cert as forge.pki.Certificate))
  return montar(forge.pki.certificateToPem(folha?.cert as forge.pki.Certificate), forge.pki.privateKeyToPem(chave), resto)
}

let flagLegado: string[] | undefined
/** O OpenSSL 3+ precisa de -legacy para abrir .pfx antigos (RC2/3DES), comuns em A1; o LibreSSL não. */
const flagsPkcs12 = (): string[] => {
  flagLegado ??= /^OpenSSL [3-9]/.test(execFileSync('openssl', ['version']).toString()) ? ['-legacy'] : []
  return flagLegado
}

const blocosPem = (texto: string, rotulo: string): string[] => texto.match(new RegExp(`-----BEGIN ${rotulo}-----[\\s\\S]+?-----END ${rotulo}-----`, 'g')) ?? []

const abrirComOpenssl = (pfx: Buffer, senha: string): Certificado => {
  const ler = (args: string[]) =>
    execFileSync('openssl', ['pkcs12', ...flagsPkcs12(), '-passin', 'env:SENHA_PFX', ...args], {
      input: pfx,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SENHA_PFX: senha },
      stdio: 'pipe',
    }).toString()
  const [folhaPem] = blocosPem(ler(['-nokeys', '-clcerts']), 'CERTIFICATE')
  const chaveTexto = ler(['-nocerts', '-nodes'])
  const [chavePem] = [...blocosPem(chaveTexto, 'PRIVATE KEY'), ...blocosPem(chaveTexto, 'RSA PRIVATE KEY')]
  if (!folhaPem || !chavePem) throw new ErroCertificado('O arquivo não tem o certificado e a chave privada juntos.')
  return montar(folhaPem, chavePem, blocosPem(ler(['-nokeys', '-cacerts']), 'CERTIFICATE'))
}

const ehSenhaErrada = (texto: string): boolean => /mac (could not be )?verif|invalid password|bad decrypt|senha/i.test(texto)

export const abrirPfx = (pfx: Buffer, senha: string): Certificado => {
  try {
    return abrirComForge(pfx, senha)
  } catch (erroForge) {
    if (erroForge instanceof ErroCertificado) throw erroForge
    if (ehSenhaErrada(String((erroForge as Error).message))) throw new ErroCertificado('Senha do certificado incorreta.')
    // Cifra que o forge não conhece (ex.: AES em .pfx gerado por OpenSSL 3): tenta o OpenSSL, se existir.
    try {
      return abrirComOpenssl(pfx, senha)
    } catch (erro) {
      if (erro instanceof ErroCertificado) throw erro
      const detalhe = String((erro as { stderr?: Buffer }).stderr ?? (erro as Error).message)
      if (ehSenhaErrada(detalhe)) throw new ErroCertificado('Senha do certificado incorreta.')
      throw new ErroCertificado('Não consegui abrir o arquivo. Ele precisa ser um certificado A1 (.pfx ou .p12).')
    }
  }
}

// ---------- cofre do sistema ----------

/** No Windows, a senha cifrada pelo DPAPI fica aqui, fora da pasta do projeto. Só o seu usuário consegue abrir. */
const arquivoDpapi = (conta: string): string => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), SERVICO, `${conta}.senha`)

const powershell = (script: string, entrada?: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`], {
    input: entrada,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString()

/** Senha guardada no cofre do sistema, ou a variável NFSE_SENHA_CERTIFICADO. */
export const lerSenha = (conta: string): string | undefined => {
  if (process.env.NFSE_SENHA_CERTIFICADO) return process.env.NFSE_SENHA_CERTIFICADO
  try {
    if (SO === 'darwin') return execFileSync('security', ['find-generic-password', '-a', conta, '-s', SERVICO, '-w'], { stdio: 'pipe' }).toString().replace(/\n$/, '')
    if (SO === 'win32') {
      if (!existsSync(arquivoDpapi(conta))) return undefined
      return powershell(
        '$e=[Console]::In.ReadToEnd().Trim();$s=ConvertTo-SecureString $e;[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)))',
        readFileSync(arquivoDpapi(conta), 'utf8'),
      )
    }
    return execFileSync('secret-tool', ['lookup', 'service', SERVICO, 'account', conta], { stdio: 'pipe' }).toString().replace(/\n$/, '') || undefined
  } catch {
    return undefined
  }
}

/** Abre uma janela do próprio sistema pedindo a senha (texto oculto). Devolve undefined se a pessoa cancelar. */
export const pedirSenhaNaTela = (mensagem: string): string | undefined => {
  try {
    if (SO === 'darwin') {
      const script = `display dialog ${JSON.stringify(mensagem)} default answer "" with hidden answer with title "Minha Nota Fiscal" buttons {"Cancelar", "Guardar"} default button "Guardar" cancel button "Cancelar"\ntext returned of result`
      return execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replace(/\n$/, '')
    }
    if (SO === 'win32') {
      const msg = mensagem.replace(/'/g, "''")
      const saida = powershell(`$c=Get-Credential -UserName 'certificado' -Message '${msg}';if($c){[Console]::Out.Write($c.GetNetworkCredential().Password)}else{exit 1}`)
      return saida
    }
    return execFileSync('zenity', ['--password', '--title=Minha Nota Fiscal', `--text=${mensagem}`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replace(/\n$/, '')
  } catch (erro) {
    if ((erro as { code?: string }).code === 'ENOENT') {
      throw new ErroCertificado('Este sistema não tem janela de senha. Defina a variável NFSE_SENHA_CERTIFICADO no seu terminal (não cole a senha no chat).')
    }
    return undefined
  }
}

/** Guarda no cofre do sistema. A senha vai pela entrada padrão, nunca pela linha de comando. */
export const guardarSenha = (conta: string, senha: string): void => {
  if (SO === 'darwin') {
    const aspas = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -a ${aspas(conta)} -s ${SERVICO} -l ${aspas('Senha do certificado da nota fiscal')} -w ${aspas(senha)}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return
  }
  if (SO === 'win32') {
    const cifrada = powershell('$s=[Console]::In.ReadToEnd();ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString', senha).trim()
    mkdirSync(join(arquivoDpapi(conta), '..'), { recursive: true })
    writeFileSync(arquivoDpapi(conta), cifrada)
    return
  }
  execFileSync('secret-tool', ['store', '--label=Senha do certificado da nota fiscal', 'service', SERVICO, 'account', conta], { input: senha, stdio: ['pipe', 'pipe', 'pipe'] })
}

export const nomeDoCofre = (): string => (SO === 'darwin' ? 'Keychain do Mac' : SO === 'win32' ? 'cofre do Windows' : 'chaveiro do sistema')

export const carregarCertificado = (caminho: string, conta: string): Certificado => {
  if (!existsSync(caminho)) throw new ErroCertificado(`Não achei o certificado em ${caminho}.`)
  const senha = lerSenha(conta)
  if (senha === undefined) throw new ErroCertificado('A senha do certificado ainda não foi guardada. Rode: node ferramentas/nfse.mjs guardar-senha')
  return abrirPfx(readFileSync(caminho), senha)
}

/** Pastas que costumam ir para a nuvem: o certificado não deve morar nelas. */
export const pastaSincronizada = (caminho: string): string | undefined => {
  const casa = homedir()
  if (/Mobile Documents|CloudStorage|Google Drive|Dropbox|OneDrive|iCloud/i.test(caminho)) return 'uma pasta de nuvem'
  if (SO === 'darwin' && (caminho.startsWith(`${casa}/Desktop/`) || caminho.startsWith(`${casa}/Documents/`))) {
    try {
      const saida = execFileSync('defaults', ['read', 'com.apple.finder', 'FXICloudDriveDesktop'], { stdio: 'pipe' }).toString().trim()
      if (saida === '1') return 'a Mesa ou os Documentos sincronizados com o iCloud'
    } catch {
      // Sem a chave: a sincronização da Mesa e Documentos não está ligada (ou não dá para saber).
    }
  }
  return undefined
}
