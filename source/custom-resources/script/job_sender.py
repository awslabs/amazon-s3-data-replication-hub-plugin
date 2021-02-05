import utils


if __name__ == "__main__":

    logger = utils.get_logger()
    logger.info('Start Finding Jobs')

    env = utils.get_finder_env()

    src_client, des_client = utils.create_clients('Finder', env)

    utils.find_and_send_jobs(src_client, des_client, env)
