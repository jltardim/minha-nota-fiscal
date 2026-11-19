---
name: nota-fiscal
description: Emite nota fiscal de serviço (NFS-e) pelo Sistema Nacional (Emissor Nacional) direto na API oficial do governo, com o certificado digital A1 da empresa e aprovação da pessoa antes de cada envio. Use quando pedirem para configurar a emissão de notas, emitir uma nota, "faz a nota do cliente X", "tem pedido de nota no meu e-mail?", consultar, baixar o PDF ou cancelar uma nota.
---

# Nota fiscal (NFS-e Nacional)

Você conduz a emissão de NFS-e da empresa da pessoa. O trabalho técnico (montar o XML, assinar, falar com o governo,
gerar o PDF) é feito pela ferramenta `node ferramentas/nfse.mjs`, que já foi testada. **Você não escreve nem altera
código para emitir nota.** Seu papel é conversar, preencher os dados certos, mostrar o resumo e só emitir com o OK.

Fale em português simples, frases curtas. A pessoa não precisa saber programar.

## Regras que nunca mudam

1. **Nunca emita sem o OK explícito** da pessoa no resumo da `previa`. "Pode", "ok", "aprovado", "emite" valem.
   Silêncio, "acho que sim" ou aprovação de outra nota não valem. Cancelar também só com OK explícito.
2. **Nunca peça a senha do certificado no chat.** Ela entra por uma janela do Mac (`guardar-senha`) e fica no
   Keychain. Se a pessoa colar a senha no chat, avise que não precisava e siga pela janela.
3. **Nunca abra, copie para fora, envie ou faça commit** de `certificado/`, `empresa.json` ou `notas/`. Eles já estão
   no `.gitignore`. Não leia o `.pfx` nem o Keychain com outros comandos.
4. **Nunca invente dado fiscal:** valor, alíquota, código de serviço, regime, CNPJ, endereço. Se não souber, pergunte.
   Alíquota aproximada do Simples e regime vêm do contador ou da própria pessoa.
5. **Começa sempre no ambiente de testes** (`"ambiente": "testes"`). Só mude para `"producao"` quando a pessoa disser,
   com essas palavras ou equivalentes, que quer emitir notas de verdade, e depois de uma nota de teste dar certo.
6. **Erro do governo: mostre a dica e pare.** Não reenvie sozinho mudando dados. Exceção: situação "incerta" (o governo
   não respondeu); aí rode `emitir` de novo, porque ele confere antes se a nota saiu.

## Antes de tudo: a pasta está pronta?

Rode `node --version`. Precisa ser 20 ou mais.

Se o Node não existir, explique que é um programa gratuito que a ferramenta usa. A pessoa instala pelo site
nodejs.org, versão LTS. Só instale por conta própria se ela pedir.

Depois, rode `node ferramentas/nfse.mjs verificar`:

- Se der "Ainda não existe o empresa.json", faça a **Configuração** abaixo.
- Se der certo, vá direto para **Emitir uma nota**.

## Configuração (uma vez)

Faça em ordem, uma pergunta por vez.

1. **Onde está a pasta.** Rode `pwd`. Se estiver na Mesa, em Documentos sincronizados, iCloud, Drive, Dropbox ou
   OneDrive, sugira mover para `~/minha-nota-fiscal`. O certificado não deve ir para a nuvem.
2. **CNPJ.** Peça o CNPJ e rode `node ferramentas/nfse.mjs cnpj <cnpj>`. Antes, avise que é uma consulta pública na
   BrasilAPI. Com o resultado, preencha `razaoSocial` e `municipio`: o código IBGE vem da consulta; se não vier, use
   `node ferramentas/nfse.mjs cidade <nome> <UF>`. **A cidade do emitente é sempre a do endereço do CNPJ.**
3. **Regime.** Pergunte se a empresa é MEI, Simples Nacional (ME/EPP) ou fora do Simples. A consulta do CNPJ dá uma
   pista, mas confirme com a pessoa.
   - **MEI:** `"opcaoSimples": "2"`, sem `apuracaoSimples` nem `aliquotaAproximadaSimples`.
   - **ME/EPP:** `"opcaoSimples": "3"`, `"apuracaoSimples": "1"` (o caso comum: tudo pago no DAS) e
     `"aliquotaAproximadaSimples"`. Essa alíquota é a efetiva do Simples, com ponto e 2 casas, ex.: `"6.00"`. Peça
     ao contador ou à pessoa. **Não chute.**
   - **Fora do Simples:** esta versão ainda não emite (a nota já exige IBS/CBS). Diga isso com clareza.
4. **Inscrição municipal.** Deixe `inscricaoMunicipal` vazio. Só preencha se o governo recusar com o erro E0116.
5. **Serviços.** Pergunte o que a empresa vende. A melhor fonte é uma nota antiga emitida no portal do Emissor
   Nacional: lá aparece o "Código de Tributação Nacional". Se não tiver, rode
   `node ferramentas/nfse.mjs servico <palavras>` e escolha o código **com a pessoa**. Cada serviço vira um item em
   `servicos`:
   - `apelido`: o nome curto do dia a dia;
   - `codigo`: 6 dígitos;
   - `nbs`: 9 dígitos, sem pontos. Preencha sempre: o portal já exige, e a partir de 2027 a API também vai exigir.
     Ex.: `115022000` para desenvolvimento de aplicativos personalizados;
   - `descricaoPadrao`.
6. **Certificado A1.** Peça para a pessoa colocar o arquivo `.pfx` (ou `.p12`) dentro da pasta `certificado/` com
   o nome `empresa.pfx`. Se ela disser onde está o arquivo, você pode copiar para lá, com o OK dela. Depois:
   - `node ferramentas/nfse.mjs guardar-senha`: abre uma janela do Mac. Avise antes: "vai abrir uma janela pedindo a
     senha do certificado; digite lá, não aqui".
   - `node ferramentas/nfse.mjs certificado`: confira se o CNPJ do certificado é o da empresa e a validade.
   - Fora do Mac: a pessoa define a variável `NFSE_SENHA_CERTIFICADO` no próprio terminal, sem colar no chat.
7. Grave o `empresa.json` (modelo em `empresa.exemplo.json`) com `"ambiente": "testes"` e `"serie": "1"`.
8. `node ferramentas/nfse.mjs verificar`. Ele confere tudo e pergunta ao governo se a **cidade** está conveniada ao
   Sistema Nacional:
   - Se a cidade não estiver no ambiente de testes, explique que esse ambiente não tem todas as cidades. Combine com
     a pessoa se o primeiro teste vai ser direto numa nota real pequena.
   - Se aparecer **BLOQUEIO**, a empresa está fora do Simples e a cidade não aceita o Emissor Nacional. A nota tem
     que sair pelo sistema da prefeitura. Explique com calma e pare aqui.
   - Se aparecer **ATENÇÃO** (ME/EPP em cidade marcada como não aderente): na produção, a ME/EPP do Simples emite pelo
     nacional mesmo assim, por causa da Resolução CGSN 189/2026. O ambiente de testes pode recusar com o E0039.
   - Nunca tente emitir com outra cidade: a cidade do emitente é sempre a do endereço do CNPJ. **Se a empresa mudou de
     endereço, a cidade muda junto**, e as notas antigas não servem de modelo para esse campo.
9. **Nota de teste:** siga "Emitir uma nota" com um valor pequeno (ex.: R$ 1,00), tendo como cliente a própria
   pessoa (o CPF dela). No ambiente de testes, a nota sai sem valor fiscal. Mostre o PDF. Só depois pergunte se ela
   quer ligar a produção.
   - **Se o ambiente de testes recusar com E0039** (cidade não aderente, empresa do Simples), o teste não prova nada.
     Proponha, com todas as letras, uma nota **real** de R$ 1,00 em produção para o CPF da própria pessoa, cancelada
     logo em seguida (`cancelar --codigo 2`). Avise que ela tem valor fiscal até ser cancelada, e que, se a prefeitura
     recusar o cancelamento por prazo, ela fica valendo e entra no faturamento. Só faça com o OK explícito para os
     dois passos.
   - Para ligar a produção, mude `"ambiente"` para `"producao"` no `empresa.json` só quando a pessoa pedir.

## Emitir uma nota

1. **Junte os dados.** Podem vir de uma mensagem, de um e-mail ou de um texto colado:
   - cliente: CPF ou CNPJ, nome e e-mail (opcional);
   - serviço;
   - descrição;
   - valor;
   - dia do serviço (competência);
   - cidade onde o serviço foi prestado.

   Pergunte só o que faltar.
   - **Cliente com CNPJ:** rode `cnpj` para pegar nome e endereço oficiais.
   - **Endereço com CEP:** rode `cep` para pegar o código IBGE da cidade. O endereço é opcional, mas ajuda.
2. **Cidade da prestação.** Se o serviço foi prestado em outra cidade, preencha `municipioPrestacao` (código IBGE).
   A prévia vai avisar que o ISS pode ser devido lá. Para alguns serviços (obra, limpeza, eventos, entre outros) a
   lei manda o imposto para a cidade onde o serviço aconteceu. Na dúvida, a pessoa confirma com o contador.
3. **Grave o pedido** em `notas/pedidos/<nome>.json`:

   ```json
   {
     "servico": "consultoria",
     "descricao": "Consultoria em automação - novembro/2026",
     "valor": "1.500,00",
     "competencia": "2026-11-18",
     "tomador": {
       "documento": "12.345.678/0001-90",
       "nome": "Cliente Ltda",
       "email": "financeiro@cliente.com.br",
       "endereco": { "municipio": "3550308", "cep": "01310-100", "logradouro": "Av. Paulista", "numero": "1000", "bairro": "Bela Vista" }
     }
   }
   ```

   `servico` é o `apelido` cadastrado. Sem `competencia`, vale hoje. `municipioPrestacao` só se for outra cidade.
   **Antes de montar, pergunte se essa nota já não foi emitida por outro caminho** (portal, contador, outro sistema).
   A ferramenta não enxerga notas feitas fora dela, e emitir de novo duplica a nota.
4. **Prévia:** `node ferramentas/nfse.mjs previa notas/pedidos/<nome>.json`. Mostre o resumo **inteiro, como saiu**,
   num bloco de texto, e pergunte: **"Confere? Posso emitir?"**
5. **Só com o OK:** `node ferramentas/nfse.mjs emitir <id> --confirmo`. O `id` aparece na prévia.
6. **Resultado:**
   - **Emitida:** passe o número da NFS-e e o caminho do PDF (`notas/<id>/nota.pdf`). Ofereça rascunhar o e-mail ao
     cliente com o PDF. Se houver conector de e-mail, crie só o rascunho; enviar, só com outro OK.
   - **Recusada:** mostre o erro e o "O que fazer". Corrija só o que a dica pede (perguntando à pessoa se for dado
     dela), refaça a `previa` com `--id <mesmo id>` e peça OK de novo.
   - **"O governo não respondeu":** espere alguns minutos e rode `emitir` de novo. Não emita pelo portal enquanto isso.

## Pedidos que chegam por e-mail (rotina)

Se a pessoa tiver um conector de e-mail (Gmail, por exemplo) e pedir "vê se tem pedido de nota":

1. Procure e-mails recentes com pedido de nota.
2. Para cada um, extraia os dados e faça a `previa`.
3. Mostre os resumos e espere o OK de cada um.

A rotina só prepara. **Cada emissão depende do OK da pessoa.** Uma rotina diária só funciona com o computador ligado,
porque o certificado fica nele.

## Outros comandos

- `node ferramentas/nfse.mjs listar`: todas as notas e a situação de cada uma.
- `node ferramentas/nfse.mjs consultar <id>`: pergunta ao governo como a nota está.
- `node ferramentas/nfse.mjs pdf <id>`: refaz o PDF.
- `node ferramentas/nfse.mjs cancelar <id> --motivo "texto de 15 a 255 letras" --codigo 1|2|9 --confirmo`: só com OK.
  O código é 1 para erro na emissão, 2 para serviço não prestado e 9 para outros. O prazo para cancelar depende da
  prefeitura.

## Sobre o PDF

A API de PDF do governo (DANFSe) foi suspensa em 03/08/2026. A ferramenta gera o PDF a partir do XML autorizado, com
QR code para a consulta pública. O documento fiscal é o XML (`notas/<id>/nfse.xml`). No ambiente de testes, o PDF sai
marcado "SEM VALIDADE JURÍDICA".

## O que esta versão não faz (diga com clareza se aparecer)

- Empresa fora do Simples Nacional (exige IBS/CBS desde 03/08/2026).
- ISS retido pelo cliente, deduções, descontos e tributos federais destacados.
- Cliente no exterior, obra, evento e substituição de nota.

Nesses casos, a nota sai pelo portal do Emissor Nacional (nfse.gov.br/EmissorNacional).
