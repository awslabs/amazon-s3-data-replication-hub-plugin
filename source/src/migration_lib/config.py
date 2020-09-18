MAX_RETRIES = 5
MAX_THREADS = 10
MAX_ATTEMPTS = 2
MAX_KEYS = 1000  # Change to 100 or 1000
MULTIPART_THRESHOLD = 50 * 1024 * 1024
CHUNK_SIZE = 10 * 1024 * 1024
QUEUE_BATCH_SIZE = 10
MAX_POOL_CONNECTION = 200
JOB_TIMEOUT = 870  # Must be less than 15 minutes

# For multipart uplaod, the max number of parts is 10000
MAX_PARTS = 10000


class JobConfig():
    """This class holds all configurations info used during a data migration job in one place. 

    Options include:
    * include_version: Whether to compare and use object info. Default to False
    * include_metedata: Whether to migrate object metadata info. Default to True
    * clean_unfinished_upload: Clean old unfinished upload parts before each migration. Default to False for resumable upload.
    * verify_md5_twice: Whether to verfied MD5 twice for mulitple parts upload. Default to False.
    * max_threads: Maximum number of threads for parallel processing
    * multipart_threshold: Threshold size to determinate whether to use multipart upload.
    * chunk_size: default chunk size for multipart upload. note this can be automatically adjusted by the process.
    * job_timeout: default time out in seconds for the process.
    """
    def __init__(self, include_version=False,
                 include_metedata=True,
                 clean_unfinished_upload=False,
                 verify_md5_twice=False,
                 max_threads=MAX_THREADS,
                 max_retries=MAX_RETRIES,
                 multipart_threshold=MULTIPART_THRESHOLD,
                 chunk_size=CHUNK_SIZE,
                 job_timeout=JOB_TIMEOUT):
        self.include_version = include_version
        self.include_metedata = include_metedata
        self.clean_unfinished_upload = clean_unfinished_upload
        self.verify_md5_twice = verify_md5_twice
        self.max_threads = max_threads
        self.max_retries = max_retries
        self.multipart_threshold = multipart_threshold
        self.chunk_size = chunk_size
        self.job_timeout = job_timeout
