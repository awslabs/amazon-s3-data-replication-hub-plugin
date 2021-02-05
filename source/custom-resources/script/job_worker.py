import utils

if __name__ == "__main__":
    logger = utils.get_logger()
    logger.info('Start transfer...')

    config = utils.get_config()
    env = utils.get_env()
    src_client, des_client = utils.create_clients('Worker', env)
    utils.process_queue(src_client, des_client, config, env)
