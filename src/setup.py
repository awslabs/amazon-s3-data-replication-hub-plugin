import os
import re
import sys

from setuptools import setup, find_packages

NAME = 'migration_lib'
ROOT = os.path.dirname(__file__)
VERSION_RE = re.compile(r'''__version__ = ['"]([0-9.]+)['"]''')


def get_version():
    init = open(os.path.join(ROOT, NAME, '__init__.py')).read()
    return VERSION_RE.search(init).group(1)

setup(
    name=NAME,
    version=get_version(),
    description="Replication Component for AWS Data Replication Hub",
    author="Amazon Web Services",
    author_email="aws@amazon.com",
    url="https://github.com/awslab/",

    # package_dir={"": "./migration_lib"},
    packages=find_packages(),

    install_requires=[
        # "boto3",
        "oss2"
    ],

    python_requires=">=3.6",

    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3 :: Only",
        "Programming Language :: Python :: 3.6",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",
    ],
)
