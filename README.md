# Minha Nota Fiscal

Emita **nota fiscal de serviço (NFS-e)** conversando com o **Claude Code** ou o **Codex**. Ele fala direto com a API
oficial do governo (Sistema Nacional NFS-e, o mesmo do Emissor Nacional), usando o certificado digital da sua empresa.

- **Sem mensalidade, sem servidor, sem custo por nota.** Tudo roda no seu computador.
- **Nada sai sem o seu OK.** A IA monta a nota, mostra o resumo e só envia quando você aprova.
- **A senha do certificado nunca passa pelo chat.** Ela vai para o Keychain do Mac por uma janela do sistema.
- **Confere a sua cidade antes.** Nem toda prefeitura aceita o Emissor Nacional, e a ferramenta avisa.

> Testado de verdade em novembro de 2026: emissão e cancelamento pela API, em produção, para uma ME do Simples Nacional.

## Do que você precisa

1. **Certificado digital A1 da empresa** (e-CNPJ, arquivo `.pfx` ou `.p12`) e a senha dele. Sem o certificado, a API
   do governo não aceita a nota. Ele é comprado numa certificadora e vale um ano.
2. **Empresa no Simples Nacional (MEI ou ME/EPP)**. Empresas fora do Simples ainda não são atendidas: desde
   agosto de 2026 a nota delas exige IBS/CBS.
3. **Um Mac** (no Windows e no Linux funciona, mas a senha precisa ir numa variável do terminal).
4. **Claude Code ou Codex** instalado, e o **Node.js** (gratuito, em nodejs.org, versão LTS).
5. Ter em mãos **uma nota antiga** sua do Emissor Nacional ajuda muito: dela saem o código do serviço e o NBS.

## Como começar (3 passos)

1. Abra o Claude Code ou o Codex e cole o prompt do arquivo [`PROMPT.md`](PROMPT.md). Ele baixa esta pasta para
   `~/minha-nota-fiscal`.
2. Coloque o certificado na pasta `certificado/` com o nome `empresa.pfx`.
3. Diga **"configura minha nota fiscal"**. A IA pergunta o que precisa, uma coisa por vez: CNPJ, regime, serviço.
   Depois confere o certificado e a cidade, e faz uma nota de teste.

Depois disso, sempre que precisar, abra a pasta no Claude Code ou no Codex e diga, por exemplo:

> emite a nota do cliente X, R$ 1.500 de consultoria de novembro

A IA mostra o resumo. Você confere e responde "pode". A nota sai, e o PDF fica em `notas/`.

## O que ela faz

| Comando (a IA roda por você) | O que faz |
|---|---|
| `verificar` | Confere o cadastro, o certificado e se a sua cidade aceita o Emissor Nacional |
| `previa` | Monta a nota, confere com o modelo oficial do governo e mostra o resumo, sem enviar |
| `emitir` | Envia ao governo (só depois do seu OK) e gera o PDF |
| `consultar` | Pergunta ao governo como a nota está |
| `cancelar` | Cancela (só com o seu OK; o prazo depende da prefeitura) |
| `cidade`, `servico`, `cep`, `cnpj` | Acham o código IBGE da cidade, o código do serviço, o NBS e os dados do cliente |

## Cuidados (leia antes)

- **Cidade e estado mandam.** A nota sai sempre pela cidade do endereço do CNPJ. Se a empresa mudou de endereço,
  muda a cidade, e as notas antigas não servem de modelo. Cada prefeitura tem as suas regras de convênio.
- **O ambiente de testes do governo não tem todas as cidades e às vezes recusa o que a produção aceita.** Se o teste
  der o erro E0039 e a sua empresa for do Simples, a skill explica o caminho: uma nota real de R$ 1,00 para você
  mesmo, cancelada logo depois.
- **Não emita a mesma nota em dois lugares.** A ferramenta não enxerga notas feitas no portal ou pelo contador.
- **Alíquota aproximada do Simples, regime e código de serviço vêm do seu contador.** A IA não chuta.
- **O certificado, o cadastro e as notas nunca vão para o Git** (estão no `.gitignore`). Não mande o certificado
  para ninguém.
- A API de PDF do governo foi suspensa em agosto de 2026. O PDF é gerado aqui, a partir do XML autorizado, com QR
  code para a consulta pública. O documento fiscal é o XML.

## O que ainda não faz

- Empresa fora do Simples Nacional (IBS/CBS).
- ISS retido pelo cliente, deduções, descontos e tributos federais destacados.
- Cliente no exterior, obra, evento e substituição de nota.

Nesses casos, emita pelo portal: [nfse.gov.br/EmissorNacional](https://www.nfse.gov.br/EmissorNacional).

## Para quem programa

- O código-fonte está em `fonte/` (TypeScript). `ferramentas/nfse.mjs` é gerado por `npm install && npm run build`.
- A assinatura (XMLDSig RSA-SHA256), o envio por mTLS e o PDF foram adaptados do
  [emissor-nfse-nacional](https://github.com/gabrielbuzziv/emissor-nfse-nacional), de Gabriel Buzzi Venturi
  (licença MIT, em `fonte/LICENSE-emissor-nfse-nacional`).
- `ferramentas/esquemas/` traz os XSD oficiais do Sistema Nacional NFS-e. `ferramentas/tabelas/` traz os Anexos A e
  B (municípios IBGE, lista nacional de serviços e NBS), convertidos para JSON.
- Documentação oficial: [gov.br/nfse, documentação técnica](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual).

## Aviso

Este projeto não tem vínculo com a Receita Federal, o Sistema Nacional NFS-e ou qualquer prefeitura, e é distribuído
sem garantia (veja a [licença](LICENSE)). A responsabilidade pelas notas é de quem as emite. Confirme a configuração
fiscal com o seu contador.
