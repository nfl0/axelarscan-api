const {
  Contract,
} = require('ethers');
const axios = require('axios');
const _ = require('lodash');
const moment = require('moment');
const config = require('config-yml');
const {
  get,
  read,
  write,
} = require('./index');
const {
  equals_ignore_case,
  to_json,
  get_granularity,
  normalize_chain,
  getProvider,
} = require('../utils');
const IAxelarGateway = require('../data/contracts/interfaces/IAxelarGateway.json');
const IBurnableMintableCappedERC20 = require('../data/contracts/interfaces/IBurnableMintableCappedERC20.json');

const environment = process.env.ENVIRONMENT || config?.environment;

const evm_chains_data = require('../data')?.chains?.[environment]?.evm || [];
const cosmos_chains_data = require('../data')?.chains?.[environment]?.cosmos || [];
const chains_data = _.concat(
  evm_chains_data,
  cosmos_chains_data,
);
const axelarnet = chains_data.find(c => c?.id === 'axelarnet');
const cosmos_non_axelarnet_chains_data = cosmos_chains_data.filter(c => c?.id !== axelarnet.id);
const assets_data = require('../data')?.assets?.[environment] || [];

const {
  endpoints,
} = { ...config?.[environment] };

module.exports = async (
  path = '',
  params = {},
  cache = false,
  cache_timeout = 15,
) => {
  let response,
    cache_hit = false;

  if (endpoints?.cli) {
    const cli = axios.create({ baseURL: endpoints.cli });

    const {
      cmd,
    } = { ...params };
    let {
      created_at,
    } = { ...params };

    const cache_id = cmd;
    let response_cache;

    // get from cache
    if (cache && cache_id?.startsWith('axelard')) {
      response_cache = await get(
        'axelard',
        cache_id,
      );

      const {
        updated_at,
      } = { ...response_cache };

      if (response_cache && moment().diff(moment(updated_at * 1000), 'minutes', true) <= cache_timeout) {
        response = response_cache;
        cache_hit = true;
      }
    }

    // cache miss
    if (!response) {
      const _response = await cli.get(
        path,
        { params },
      ).catch(error => { return { data: { error } }; });

      const {
        data,
      } = { ..._response };

      response = data;
    }

    const {
      stdout,
    } = { ...response };

    if (stdout) {
      if (cmd?.startsWith('axelard q snapshot proxy ')) {
        response.type = 'proxy';
      }
      else if (
        (
          cmd?.startsWith('axelard q evm batched-commands ') ||
          cmd?.startsWith('axelard q evm latest-batched-commands ')
        ) &&
        cmd?.endsWith(' -oj')
      ) {
        let data = to_json(stdout);

        if (data) {
          const {
            id,
            command_ids,
            status,
          } = { ...data };
          let {
            batch_id,
          } = { ...data };

          batch_id = id;
          const chain = cmd.split(' ')[4]?.toLowerCase();
          const chain_data = evm_chains_data.find(c => equals_ignore_case(c?.id, chain));
          const provider = getProvider(chain_data);
          const {
            chain_id,
            gateway_address,
          } = { ...chain_data };

          const gateway_contract = gateway_address &&
            new Contract(
              gateway_address,
              IAxelarGateway.abi,
              provider,
            );

          const _response = await read(
            'batches',
            {
              match_phrase: { batch_id },
            },
            {
              size: 1,
            },
          );

          let {
            commands,
          } = { ..._.head(_response?.data) };

          commands = commands || [];

          if (command_ids) {
            const _commands = _.cloneDeep(commands);

            for (const command_id of command_ids) {
              if (command_id) {
                const index = commands.findIndex(c => equals_ignore_case(c?.id, command_id));

                let command = commands[index];

                if (!command) {
                  const __response = await cli.get(
                    path,
                    {
                      params: {
                        cmd: `axelard q evm command ${chain} ${command_id} -oj`,
                        cache: true,
                        cache_timeout: 1,
                      },
                    },
                  ).catch(error => { return { data: { error } }; });

                  command = to_json(__response?.data?.stdout);
                }

                if (command) {
                  let {
                    executed,
                    deposit_address,
                  } = { ...command };
                  const {
                    salt,
                  } = { ...command.params };

                  if (!executed) {
                    try {
                      if (gateway_contract) {
                        executed = await gateway_contract.isCommandExecuted(`0x${command_id}`);
                      }
                    } catch (error) {}
                  }

                  if (
                    !deposit_address &&
                    salt &&
                    (
                      command_ids.length < 15 ||
                      _commands.filter(c => c?.salt && !c.deposit_address).length < 15 ||
                      Math.random(0, 1) < 0.3
                    )
                  ) {
                    try {
                      const asset_data = assets_data.find(a => a?.contracts?.findIndex(c => c?.chain_id === chain_id && !c?.is_native) > -1);

                      const {
                        contracts,
                      } = { ...asset_data };

                      const contract_data = contracts?.find(c => c?.chain_id === chain_id);

                      const {
                        contract_address,
                      } = { ...contract_data };

                      const erc20_contract = contract_address &&
                        new Contract(
                          contract_address,
                          IBurnableMintableCappedERC20.abi,
                          provider,
                        );

                      if (erc20_contract) {
                        deposit_address = await erc20_contract.depositAddress(salt);
                      }
                    } catch (error) {}
                  }

                  command = {
                    ...command,
                    executed,
                    deposit_address,
                  };
                }

                if (index > -1) {
                  commands[index] = command;
                }
                else {
                  commands.push(command);
                }
              }
            }
          }

          commands = commands
            .filter(c => c);

          data = {
            ...data,
            batch_id,
            chain,
            commands,
          };

          if (created_at) {
            created_at = moment(Number(created_at) * 1000).utc().valueOf();
          }
          else {
            const __response = await read(
              'batches',
              {
                match_phrase: { batch_id },
              },
              {
                size: 1,
              },
            );

            const {
              ms,
            } = { ..._.head(__response?.data)?.created_at };

            created_at = (ms ?
              moment(ms) :
              moment()
            ).valueOf();
          }

          data = {
            ...data,
            created_at: get_granularity(created_at),
          };

          if (
            [
              'BATCHED_COMMANDS_STATUS_SIGNED',
            ].includes(status) &&
            command_ids &&
            gateway_contract
          ) {
            const _command_ids = command_ids.filter(c => parseInt(c, 16) >= 1);

            let sign_batch = {
              chain,
              batch_id,
              created_at: data.created_at,
            };

            for (const command_id of _command_ids) {
              const transfer_id = parseInt(command_id, 16);

              sign_batch = {
                ...sign_batch,
                command_id,
                transfer_id,
              };

              const __response = await read(
                'transfers',
                {
                  bool: {
                    should: [
                      { match: { 'confirm_deposit.transfer_id': transfer_id } },
                      { match: { 'vote.transfer_id': transfer_id } },
                      { match: { transfer_id } },
                    ],
                    minimum_should_match: 1,
                  },
                },
                {
                  size: 100,
                },
              );

              if (__response?.data?.length > 0) {
                let {
                  executed,
                } = { ..._.head(__response.data).sign_batch };

                executed = !!executed ||
                  commands.find(c => c?.id === command_id)?.executed;

                if (!executed) {
                  try {
                    executed = await gateway_contract.isCommandExecuted(`0x${command_id}`);
                  } catch (error) {}
                }

                sign_batch = {
                  ...sign_batch,
                  executed,
                };

                const transfers_data = __response.data
                  .filter(t => t?.source?.id);

                for (const transfer_data of transfers_data) {
                  const {
                    source,
                  } = { ...transfer_data };
                  const {
                    id,
                    sender_chain,
                    sender_address,
                    recipient_address,
                  } = { ...source };

                  await write(
                    'transfers',
                    `${id}_${recipient_address}`.toLowerCase(),
                    {
                      ...transfer_data,
                      sign_batch,
                      source: {
                        ...source,
                        sender_chain: normalize_chain(
                          cosmos_non_axelarnet_chains_data.find(c => sender_address?.startsWith(c?.prefix_address))?.id ||
                          sender_chain
                        ),
                      },
                    },
                  );
                }
              }
            }
          }

          await write(
            'batches',
            id,
            data,
          );

          response.stdout = JSON.stringify(data);
        }
      }

      // save cache
      if (cache && cache_id?.startsWith('axelard') && !cache_hit) {
        await write(
          'axelard',
          cache_id,
          {
            ...response,
            updated_at: moment().unix(),
          },
        );
      }
    }
    else if (response_cache) {
      response = response_cache;
    }

    response = {
      ...response,
      cache_hit,
    };
  }

  return response;
};