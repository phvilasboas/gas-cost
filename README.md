# GasCost

Aplicação web responsiva para acompanhar combustível, consumo e manutenção de um ou mais veículos. Os dados ficam persistidos em um volume do Docker.

O painel inclui:

- cadastro e edição de abastecimentos com hodômetro e tanque completo ou parcial;
- consumo médio em km/L, custo por quilômetro e aviso de queda de rendimento;
- preço médio geral e por combustível;
- vários veículos, cada um com seu próprio histórico;
- evolução mensal e comparação com o mês anterior;
- análise de preço por posto;
- manutenção, despesas e lembretes por data ou quilometragem;
- exportação em CSV e Excel, além do backup dos dados em JSON;
- instalação no celular ou computador como aplicativo, com atalho para um novo abastecimento.

No primeiro acesso, a aplicação solicitará a criação da conta administradora. Depois disso, será necessário fazer login. Usuários, senhas protegidas e sessões ficam no banco SQLite `/app/data/auth.db`. Os veículos, abastecimentos e manutenções ficam no SQLite `/app/data/gascost.db`. Ambos permanecem no mesmo volume e no mesmo container.

Ao iniciar a nova versão pela primeira vez, os abastecimentos que já existirem em `/app/data/fuel.json` serão importados automaticamente para o SQLite. O arquivo antigo é preservado e a importação não se repete.

## Executar com Docker

Crie o token usado somente para proteger a configuração da primeira conta:

```bash
cp .env.example .env
openssl rand -base64 32
```

Copie o valor gerado para `BOOTSTRAP_TOKEN` no arquivo `.env`. Em seguida:

```bash
docker compose up --build -d
```

A aplicação escuta somente em `127.0.0.1:3004` e espera ser acessada externamente por [https://gascost.vilasboas.it](https://gascost.vilasboas.it), através do HAProxy. No primeiro acesso, informe também o token definido no `.env`.

Para encerrar:

```bash
docker compose down
```

O comando acima preserva os dados. Para também remover todos os registros, use `docker compose down -v`.

### Uso em um domínio com HTTPS

Os controles de produção já estão ativos no `compose.yaml`: cookie exclusivo para HTTPS, validação do domínio e da origem, suporte ao IP encaminhado pelo proxy, porta local e privilégios reduzidos do container.

Um trecho de referência para o HAProxy está em `deploy/haproxy-gascost.cfg`. Incorpore as regras compatíveis ao `haproxy.cfg` do host e valide a configuração antes de recarregá-lo.

Depois de criar a conta administradora, você pode apagar `BOOTSTRAP_TOKEN` do `.env` e recriar o container. A conta e os dados continuarão preservados no volume.

## Desenvolvimento local

Requer Node.js 22.13 ou superior. Não é necessário instalar dependências.

Para executar fora do container, as variáveis de produção devem ser ajustadas ou removidas, pois o domínio publicado e o cookie HTTPS não funcionam em uma URL HTTP local.

```bash
npm run dev
```

Testes:

```bash
npm test
```
